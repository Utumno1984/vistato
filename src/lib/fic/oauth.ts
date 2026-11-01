import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { isJsonContentType, LOOPBACK_HOSTS, readBody } from "./client";
import {
  FicConfigError,
  FicHttpError,
  FicInvalidArgumentError,
  FicInvalidResponseError,
  FicNetworkError,
  FicServerError,
  FicTimeoutError,
  FIC_BODY_EXCERPT_MAX_BYTES,
  redactExcerpt,
} from "./errors";
import { type FicOAuthTokens, oauthTokenResponseSchema } from "./schemas";

/**
 * OAuth2 Authorization Code + PKCE (S256) towards Fatture in Cloud: configuration, the
 * authorization URL and the exchange of the code for the tokens. It knows nothing about
 * tenants or the database (see `src/lib/fic-connection/`).
 *
 * The client secret, the code, the verifier and the tokens never appear in a URL, a message
 * or an error: the excerpt of a FiC error body is redacted of all of them.
 */

export const FIC_DEFAULT_OAUTH_AUTHORIZE_URL = "https://api-v2.fattureincloud.it/oauth/authorize";
export const FIC_DEFAULT_OAUTH_TOKEN_URL = "https://api-v2.fattureincloud.it/oauth/token";

/**
 * The OAuth scopes Vistato asks for: the single place to change them. Reading the received
 * documents (with their XML) and subscribing to their webhook need `received_documents:r`
 * only; `GET /user/companies` needs no scope. To be confirmed by the spike (#57, question 5).
 */
export const FIC_OAUTH_SCOPES = ["received_documents:r"] as const;
/** The scopes as sent to FiC: space-separated. */
export const FIC_OAUTH_SCOPE = FIC_OAUTH_SCOPES.join(" ");

/** Timeout of the token exchange, response body included. */
export const FIC_OAUTH_TIMEOUT_MS = 15_000;
/** Max size of a token response: anything larger is refused, not buffered. */
export const FIC_OAUTH_MAX_RESPONSE_BYTES = 64 * 1024;
/** Longest authorization code accepted from the callback (it travels in a URL). */
export const FIC_OAUTH_CODE_MAX_LENGTH = 2048;

export interface FicOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizeUrl: string;
  tokenUrl: string;
}

type Env = Readonly<Record<string, string | undefined>>;

/** https, or plain http only towards this machine (fake FiC in tests and e2e); no credentials, no fragment. */
function parseEndpoint(name: string, raw: string, options: { allowQuery: boolean }): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FicConfigError(`${name} is not a valid URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new FicConfigError(`${name} must be an http(s) URL`);
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new FicConfigError(`${name} must use https (http is allowed only for localhost)`);
  }
  if (url.username !== "" || url.password !== "") throw new FicConfigError(`${name} must not contain credentials`);
  if (url.hash !== "" || raw.includes("#")) throw new FicConfigError(`${name} must not contain a fragment`);
  if (!options.allowQuery && url.search !== "") throw new FicConfigError(`${name} must not contain a query`);
  return url.href;
}

function readRequired(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new FicConfigError(`${name} is not set`);
  // Visible ASCII: it goes into a URL and a JSON body; nothing else is a credible id or secret.
  if (!/^[\x21-\x7e]{1,512}$/.test(value)) throw new FicConfigError(`${name} is malformed`);
  return value;
}

function readUrl(env: Env, name: string, fallback: string | null): string {
  const raw = env[name]?.trim();
  if (!raw) {
    if (fallback === null) throw new FicConfigError(`${name} is not set`);
    return fallback;
  }
  return parseEndpoint(name, raw, { allowQuery: false });
}

/**
 * Reads `FIC_CLIENT_ID`, `FIC_CLIENT_SECRET`, `FIC_REDIRECT_URI` (required) and
 * `FIC_OAUTH_AUTHORIZE_URL`, `FIC_OAUTH_TOKEN_URL` (default the real FiC endpoints).
 * @throws FicConfigError naming the variable (never its value).
 */
export function readFicOAuthConfig(env: Env = process.env): FicOAuthConfig {
  return {
    clientId: readRequired(env, "FIC_CLIENT_ID"),
    clientSecret: readRequired(env, "FIC_CLIENT_SECRET"),
    redirectUri: readUrl(env, "FIC_REDIRECT_URI", null),
    authorizeUrl: readUrl(env, "FIC_OAUTH_AUTHORIZE_URL", FIC_DEFAULT_OAUTH_AUTHORIZE_URL),
    tokenUrl: readUrl(env, "FIC_OAUTH_TOKEN_URL", FIC_DEFAULT_OAUTH_TOKEN_URL),
  };
}

/** 32 random bytes in base64url (256 bits, 43 characters). */
function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Shape of every `state` Vistato issues: anything else is not one of ours. */
export const FIC_OAUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A new random `state` (256 bits). */
export function createOAuthState(): string {
  return randomToken();
}

export interface PkcePair {
  /** RFC 7636 `code_verifier`: 43 unreserved characters (256 bits). */
  verifier: string;
  /** `BASE64URL(SHA256(verifier))`, sent with `code_challenge_method=S256`. */
  challenge: string;
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function createPkcePair(): PkcePair {
  const verifier = randomToken();
  return { verifier, challenge: pkceChallenge(verifier) };
}

/** The FiC authorization URL the browser is sent to. */
export function buildAuthorizationUrl(config: FicOAuthConfig, params: { state: string; codeChallenge: string }): string {
  const url = new URL(config.authorizeUrl);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: FIC_OAUTH_SCOPE,
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.href;
}

/** Whether a code received on the callback may be sent to FiC at all: visible ASCII, bounded. */
export function isPlausibleAuthorizationCode(code: unknown): code is string {
  return typeof code === "string" && code.length <= FIC_OAUTH_CODE_MAX_LENGTH && /^[\x21-\x7e]+$/.test(code);
}

export interface ExchangeCodeOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const TIMEOUT = Symbol("fic-oauth-timeout");

/** Every secret of the exchange redacted from a FiC response body (longest first). */
function redactAll(text: string, secrets: readonly string[]): string {
  let excerpt = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) excerpt = redactExcerpt(excerpt, secret);
  return excerpt;
}

/**
 * Exchanges an authorization code for the tokens (`grant_type=authorization_code`, with the
 * PKCE verifier), as a JSON POST to the token URL. Never retried: a code is single use.
 * Redirects are not followed. A 2xx body is validated with Zod, nothing partial is returned.
 * @throws FicInvalidArgumentError for a code that cannot be sent (nothing is sent).
 * @throws FicHttpError (4xx), FicServerError (5xx), FicInvalidResponseError (2xx not valid),
 *   FicNetworkError, FicTimeoutError: none of them carries a secret.
 */
export async function exchangeAuthorizationCode(
  config: FicOAuthConfig,
  params: { code: string; codeVerifier: string },
  options: ExchangeCodeOptions = {},
): Promise<FicOAuthTokens> {
  if (!isPlausibleAuthorizationCode(params.code)) throw new FicInvalidArgumentError("Authorization code malformed");
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? FIC_OAUTH_TIMEOUT_MS;
  const path = new URL(config.tokenUrl).pathname;
  const secrets = [config.clientSecret, params.code, params.codeVerifier];
  const details = { method: "POST" as const, path, attempts: 1 };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(TIMEOUT), timeoutMs);
  let status: number;
  let headers: Headers;
  let body: Uint8Array;
  let tooLarge: boolean;
  try {
    const response = await doFetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        code: params.code,
        code_verifier: params.codeVerifier,
      }),
      redirect: "manual",
      signal: controller.signal,
      cache: "no-store",
    });
    status = response.status;
    headers = response.headers;
    const ok = status >= 200 && status < 300;
    ({ body, tooLarge } = await readBody(response, ok ? FIC_OAUTH_MAX_RESPONSE_BYTES : FIC_BODY_EXCERPT_MAX_BYTES));
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason === TIMEOUT) {
      throw new FicTimeoutError(`FiC POST ${path}: no response within ${timeoutMs} ms`, { ...details, timeoutMs });
    }
    if (!(error instanceof TypeError)) throw error;
    const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
    const code = typeof cause?.code === "string" ? cause.code : undefined;
    throw new FicNetworkError(`FiC POST ${path}: network error${code ? ` (${code})` : ""}`, { ...details, code });
  } finally {
    clearTimeout(timer);
  }

  const bodyExcerpt = redactAll(new TextDecoder().decode(body), secrets);
  const label = `FiC POST ${path} answered ${status}`;
  if (status >= 500 && status < 600) throw new FicServerError(label, { ...details, status, bodyExcerpt });
  if (status < 200 || status >= 300) throw new FicHttpError(label, { ...details, status, bodyExcerpt });

  const fail = (reason: string) =>
    new FicInvalidResponseError(`FiC POST ${path}: ${reason}`, { ...details, status, bodyExcerpt: "[REDACTED]" });
  // A 2xx body holds the tokens: it is never kept in an error, not even redacted.
  if (tooLarge) throw fail(`response body larger than ${FIC_OAUTH_MAX_RESPONSE_BYTES} bytes`);
  if (!isJsonContentType(headers.get("content-type"))) throw fail("response is not JSON (Content-Type)");
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw fail("response body is not valid JSON");
  }
  const parsed = oauthTokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    const where = parsed.error.issues
      .slice(0, 5)
      .map((issue) => issue.path.join(".") || "(root)")
      .join(", ");
    throw fail(`response does not match the expected schema at ${where}`);
  }
  return parsed.data;
}
