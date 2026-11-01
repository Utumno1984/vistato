import type { z } from "zod";

import {
  FicConfigError,
  FicError,
  FicForbiddenError,
  FicHttpError,
  type FicHttpMethod,
  FicInvalidArgumentError,
  FicInvalidResponseError,
  FicNetworkError,
  FicNotFoundError,
  FicRateLimitedError,
  FicServerError,
  FicTimeoutError,
  FicUnauthorizedError,
  FIC_BODY_EXCERPT_MAX_BYTES,
  redactExcerpt,
} from "./errors";
import {
  FIC_DEFAULT_MAX_REQUESTS,
  FIC_DEFAULT_WINDOW_MS,
  realSleep,
  type Clock,
  type Sleep,
  SlidingWindowRateLimiter,
} from "./rate-limiter";
import {
  companyInfoResponseSchema,
  type FicCompany,
  type FicCompanyInfo,
  ficIdSchema,
  listCompaniesResponseSchema,
} from "./schemas";

/**
 * Server-side client of the Fatture in Cloud API v2. It knows nothing about tenants or the
 * database: the caller passes the access token and the FiC company id (tenant isolation is
 * the caller's job, reading the token through `forTenant(...)`).
 *
 * - Base URL from `FIC_API_BASE_URL` (default {@link FIC_DEFAULT_BASE_URL}), http(s) only.
 * - Per-company limit ({@link SlidingWindowRateLimiter}) shared by the whole process.
 * - Retries: 429 honouring `Retry-After` (capped at {@link FIC_MAX_RETRY_AFTER_MS});
 *   5xx, network errors and timeouts only for idempotent requests (GET), with growing
 *   backoff and jitter; 401/403/404 and other statuses never.
 * - Every 2xx body is validated with Zod; on failure nothing partial is returned.
 * - The token travels only in the `Authorization` header: never in a URL, a message or an
 *   error. Redirects are not followed (the header must not reach another host).
 */

export const FIC_DEFAULT_BASE_URL = "https://api-v2.fattureincloud.it";
export const FIC_DEFAULT_MAX_ATTEMPTS = 3;
export const FIC_DEFAULT_TIMEOUT_MS = 15_000;
/** Base of the exponential backoff (attempt n waits between base·2^(n-2) and base·2^(n-1)). */
export const FIC_DEFAULT_BACKOFF_BASE_MS = 500;
/** Cap of a single backoff wait. */
export const FIC_MAX_BACKOFF_MS = 30_000;
/** Cap of the wait asked by `Retry-After` (a huge or hostile value cannot stall us). */
export const FIC_MAX_RETRY_AFTER_MS = 60_000;
/** Max size of a successful response body: anything larger is refused, not buffered. */
export const FIC_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export interface FicClientOptions {
  /** Base URL of the API. Default: `FIC_API_BASE_URL` or {@link FIC_DEFAULT_BASE_URL}. */
  baseUrl?: string;
  /** Per-company limiter. Default: the one shared by the process (configured from the environment). */
  rateLimiter?: SlidingWindowRateLimiter;
  /** Total attempts including the first one (≥ 1). Default {@link FIC_DEFAULT_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Timeout of one attempt, response body included. Default {@link FIC_DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Base of the retry backoff. Default {@link FIC_DEFAULT_BACKOFF_BASE_MS}. */
  backoffBaseMs?: number;
  /** Waits between attempts (injectable for tests). */
  sleep?: Sleep;
  /** Current time, used to read a `Retry-After` HTTP date (injectable for tests). */
  now?: Clock;
  /** Random number in [0, 1) for the jitter (injectable for tests). */
  random?: () => number;
  /** `fetch` implementation (injectable for tests). */
  fetch?: typeof fetch;
}

export interface FicRequest<Schema extends z.ZodType> {
  method: FicHttpMethod;
  /** Path below the base URL, starting with `/` (e.g. `/user/companies`). */
  path: string;
  token: string;
  /** FiC company the request counts against (rate limit key). Omit for user-level endpoints. */
  companyId?: number;
  schema: Schema;
  /** JSON body (POST). */
  body?: unknown;
}

export interface FicClient {
  readonly baseUrl: string;
  /** `GET /user/companies`: companies the token can access. Not rate limited per company (no company). */
  listCompanies(token: string): Promise<FicCompany[]>;
  /** `GET /c/{company_id}/company/info`. */
  getCompanyInfo(token: string, companyId: number): Promise<FicCompanyInfo>;
  /** Generic request, for the endpoints added by later tickets (with their own schema). */
  request<Schema extends z.ZodType>(request: FicRequest<Schema>): Promise<z.output<Schema>>;
}

/**
 * Validates and normalises a base URL: http(s), no credentials, no query or fragment,
 * no trailing slash (so `https://x/` and `https://x` give the same request URLs).
 */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new FicConfigError("FIC_API_BASE_URL is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new FicConfigError("FIC_API_BASE_URL must be an http(s) URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new FicConfigError("FIC_API_BASE_URL must not contain credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new FicConfigError("FIC_API_BASE_URL must not contain a query or a fragment");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

type Env = Readonly<Record<string, string | undefined>>;

function readPositiveIntEnv(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (!/^[1-9]\d{0,8}$/.test(raw)) throw new FicConfigError(`${name} must be a positive integer`);
  return Number(raw);
}

export interface FicEnvConfig {
  baseUrl: string;
  rateLimitMaxRequests: number;
  rateLimitWindowMs: number;
}

/** Reads `FIC_API_BASE_URL`, `FIC_RATE_LIMIT_MAX_REQUESTS`, `FIC_RATE_LIMIT_WINDOW_SECONDS`. */
export function readFicConfig(env: Env = process.env): FicEnvConfig {
  const rawBase = env.FIC_API_BASE_URL?.trim();
  return {
    baseUrl: normalizeBaseUrl(rawBase ? rawBase : FIC_DEFAULT_BASE_URL),
    rateLimitMaxRequests: readPositiveIntEnv(env, "FIC_RATE_LIMIT_MAX_REQUESTS", FIC_DEFAULT_MAX_REQUESTS),
    rateLimitWindowMs: readPositiveIntEnv(env, "FIC_RATE_LIMIT_WINDOW_SECONDS", FIC_DEFAULT_WINDOW_MS / 1000) * 1000,
  };
}

/**
 * Wait asked by a `Retry-After` header, in ms, capped at {@link FIC_MAX_RETRY_AFTER_MS}.
 * Delay in seconds (`"2"`) or HTTP date (in the past = 0). `null` when absent or unreadable
 * (negative, decimal, garbage): the caller then falls back to its backoff.
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, FIC_MAX_RETRY_AFTER_MS);
  }
  // HTTP date (IMF-fixdate, or the obsolete RFC 850 / asctime forms): starts with a day name.
  if (/^[A-Za-z]{3,9},? /.test(trimmed)) {
    const date = Date.parse(trimmed);
    if (Number.isNaN(date)) return null;
    return Math.min(Math.max(date - nowMs, 0), FIC_MAX_RETRY_AFTER_MS);
  }
  return null;
}

function assertToken(token: unknown): asserts token is string {
  // Visible ASCII only: no spaces, CR/LF (header injection) or other characters.
  if (typeof token !== "string" || !/^[\x21-\x7e]+$/.test(token)) {
    throw new FicInvalidArgumentError("FiC access token missing or malformed");
  }
}

function assertCompanyId(companyId: unknown): asserts companyId is number {
  if (!ficIdSchema.safeParse(companyId).success) {
    throw new FicInvalidArgumentError("FiC companyId must be a positive integer");
  }
}

function assertPath(path: unknown): asserts path is string {
  // Same origin as the base URL: absolute path, safe characters, no query, no dot segments
  // and no empty segments (`//host/x` must never look like a protocol-relative URL).
  if (
    typeof path !== "string" ||
    !/^\/[A-Za-z0-9_\-./]+$/.test(path) ||
    path
      .slice(1)
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new FicInvalidArgumentError("FiC request path is not valid");
  }
}

function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  const mediaType = value.split(";")[0].trim().toLowerCase();
  return mediaType === "application/json" || /^application\/[a-z0-9.+-]+\+json$/.test(mediaType);
}

interface RawResponse {
  status: number;
  headers: Headers;
  /** Full body for 2xx (up to the max size), first bytes otherwise. */
  body: Uint8Array;
  tooLarge: boolean;
}

/** Reads at most `limit` bytes, then cancels the rest of the stream. */
async function readBody(response: Response, limit: number): Promise<{ body: Uint8Array; tooLarge: boolean }> {
  if (!response.body) return { body: new Uint8Array(), tooLarge: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let tooLarge = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.length > limit) {
        chunks.push(value.subarray(0, limit - total));
        total = limit;
        tooLarge = true;
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    if (tooLarge) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return { body, tooLarge };
}

const TIMEOUT = Symbol("fic-timeout");

export function createFicClient(options: FicClientOptions = {}): FicClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? readFicConfig().baseUrl);
  const maxAttempts = options.maxAttempts ?? FIC_DEFAULT_MAX_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? FIC_DEFAULT_TIMEOUT_MS;
  const backoffBaseMs = options.backoffBaseMs ?? FIC_DEFAULT_BACKOFF_BASE_MS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new FicConfigError("maxAttempts must be a positive integer");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new FicConfigError("timeoutMs must be a positive integer of milliseconds");
  }
  if (!Number.isSafeInteger(backoffBaseMs) || backoffBaseMs < 0) {
    throw new FicConfigError("backoffBaseMs must be a non-negative integer of milliseconds");
  }
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const doFetch = options.fetch ?? fetch;
  const limiter = options.rateLimiter ?? sharedRateLimiter();

  /** Attempt n (1-based) waits in [exp/2, exp], exp = base·2^(n-1) capped: growing, with jitter. */
  function backoff(attempt: number): number {
    const exp = Math.min(backoffBaseMs * 2 ** (attempt - 1), FIC_MAX_BACKOFF_MS);
    return Math.round(exp / 2 + random() * (exp / 2));
  }

  async function send(
    method: FicHttpMethod,
    path: string,
    token: string,
    body: unknown,
    attempts: number,
  ): Promise<RawResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(TIMEOUT), timeoutMs);
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: controller.signal,
        cache: "no-store",
      });
      const ok = response.status >= 200 && response.status < 300;
      const { body: bytes, tooLarge } = await readBody(response, ok ? FIC_MAX_RESPONSE_BYTES : FIC_BODY_EXCERPT_MAX_BYTES);
      return { status: response.status, headers: response.headers, body: bytes, tooLarge };
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason === TIMEOUT) {
        throw new FicTimeoutError(`FiC ${method} ${path}: no response within ${timeoutMs} ms`, {
          method,
          path,
          attempts,
          timeoutMs,
        });
      }
      const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
      const code = typeof cause?.code === "string" ? cause.code : undefined;
      throw new FicNetworkError(`FiC ${method} ${path}: network error${code ? ` (${code})` : ""}`, {
        method,
        path,
        attempts,
        code,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  function parseSuccess<Schema extends z.ZodType>(
    raw: RawResponse,
    schema: Schema,
    details: { method: FicHttpMethod; path: string; attempts: number; token: string },
  ): z.output<Schema> {
    const excerpt = () => redactExcerpt(new TextDecoder().decode(raw.body), details.token);
    const fail = (reason: string) =>
      new FicInvalidResponseError(`FiC ${details.method} ${details.path}: ${reason}`, {
        method: details.method,
        path: details.path,
        status: raw.status,
        attempts: details.attempts,
        bodyExcerpt: excerpt(),
      });
    if (raw.tooLarge) throw fail(`response body larger than ${FIC_MAX_RESPONSE_BYTES} bytes`);
    if (!isJsonContentType(raw.headers.get("content-type"))) throw fail("response is not JSON (Content-Type)");
    if (raw.body.length === 0) throw fail("empty response body");
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw.body));
    } catch {
      throw fail("response body is not valid JSON");
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      // Only the paths of the issues: the values are untrusted and may be large.
      const where = parsed.error.issues
        .slice(0, 5)
        .map((issue) => issue.path.join(".") || "(root)")
        .join(", ");
      throw fail(`response does not match the expected schema at ${where}`);
    }
    return parsed.data;
  }

  async function request<Schema extends z.ZodType>(req: FicRequest<Schema>): Promise<z.output<Schema>> {
    const { method, path, token, companyId, schema, body } = req;
    assertToken(token);
    assertPath(path);
    if (companyId !== undefined) assertCompanyId(companyId);
    const idempotent = method === "GET";

    for (let attempt = 1; ; attempt++) {
      const last = attempt >= maxAttempts;
      if (companyId !== undefined) await limiter.acquire(String(companyId));

      let raw: RawResponse;
      try {
        raw = await send(method, path, token, body, attempt);
      } catch (error) {
        if (!(error instanceof FicError)) throw error;
        if (!idempotent || last) throw error;
        await sleep(backoff(attempt));
        continue;
      }

      const details = {
        method,
        path,
        status: raw.status,
        attempts: attempt,
        bodyExcerpt: redactExcerpt(new TextDecoder().decode(raw.body), token),
      };
      const label = `FiC ${method} ${path} answered ${raw.status}`;
      if (raw.status >= 200 && raw.status < 300) {
        return parseSuccess(raw, schema, { method, path, attempts: attempt, token });
      }
      if (raw.status === 401) throw new FicUnauthorizedError(label, details);
      if (raw.status === 403) throw new FicForbiddenError(label, details);
      if (raw.status === 404) throw new FicNotFoundError(label, details);
      if (raw.status === 429) {
        const retryAfterMs = parseRetryAfter(raw.headers.get("retry-after"), now());
        if (last) throw new FicRateLimitedError(label, { ...details, retryAfterMs: retryAfterMs ?? undefined });
        await sleep(retryAfterMs ?? backoff(attempt));
        continue;
      }
      if (raw.status >= 500 && raw.status < 600) {
        if (!idempotent || last) throw new FicServerError(label, details);
        await sleep(backoff(attempt));
        continue;
      }
      throw new FicHttpError(label, details);
    }
  }

  return {
    baseUrl,
    listCompanies(token) {
      return request({ method: "GET", path: "/user/companies", token, schema: listCompaniesResponseSchema });
    },
    async getCompanyInfo(token, companyId) {
      assertCompanyId(companyId);
      const info = await request({
        method: "GET",
        path: `/c/${companyId}/company/info`,
        token,
        companyId,
        schema: companyInfoResponseSchema,
      });
      if (info.companyId !== companyId) {
        throw new FicInvalidResponseError(
          `FiC GET /c/${companyId}/company/info: response is about another company`,
          { method: "GET", path: `/c/${companyId}/company/info`, status: 200 },
        );
      }
      return info;
    },
    request,
  };
}

let processRateLimiter: SlidingWindowRateLimiter | undefined;

/** One limiter per process, shared by every client that does not bring its own. */
function sharedRateLimiter(): SlidingWindowRateLimiter {
  if (!processRateLimiter) {
    const config = readFicConfig();
    processRateLimiter = new SlidingWindowRateLimiter({
      maxRequests: config.rateLimitMaxRequests,
      windowMs: config.rateLimitWindowMs,
    });
  }
  return processRateLimiter;
}

let defaultClient: FicClient | undefined;

function getDefaultClient(): FicClient {
  defaultClient ??= createFicClient();
  return defaultClient;
}

/** `GET /user/companies` with the default client (configured from the environment). */
export function listCompanies(token: string): Promise<FicCompany[]> {
  return getDefaultClient().listCompanies(token);
}

/** `GET /c/{company_id}/company/info` with the default client (configured from the environment). */
export function getCompanyInfo(token: string, companyId: number): Promise<FicCompanyInfo> {
  return getDefaultClient().getCompanyInfo(token, companyId);
}
