import "server-only";

import { createHash, randomBytes } from "node:crypto";

import type { z } from "zod";

import { isJsonContentType, LOOPBACK_HOSTS, readBody } from "./client";
import {
  FicConfigError,
  FicInvalidArgumentError,
  FicInvalidResponseError,
  FicNetworkError,
  FicOAuthHttpError,
  FicServerError,
  FicTimeoutError,
  FIC_BODY_EXCERPT_MAX_BYTES,
  redactExcerpt,
} from "./errors";
import {
  FIC_OAUTH_TOKEN_MAX_LENGTH,
  type FicOAuthRefreshedTokens,
  type FicOAuthTokens,
  oauthRefreshResponseSchema,
  oauthTokenResponseSchema,
} from "./schemas";

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
  /**
   * RFC 7009 revocation endpoint, used when a tenant unlinks its account. Optional: FiC does
   * not document one (to be confirmed by the spike, #57), so revocation is attempted only
   * when `FIC_OAUTH_REVOKE_URL` is set.
   */
  revokeUrl?: string;
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
 * Reads `FIC_CLIENT_ID`, `FIC_CLIENT_SECRET`, `FIC_REDIRECT_URI` (required),
 * `FIC_OAUTH_AUTHORIZE_URL`, `FIC_OAUTH_TOKEN_URL` (default the real FiC endpoints) and
 * `FIC_OAUTH_REVOKE_URL` (optional, no default: `revokeUrl` is absent when it is not set).
 * @throws FicConfigError naming the variable (never its value).
 */
export function readFicOAuthConfig(env: Env = process.env): FicOAuthConfig {
  const config: FicOAuthConfig = {
    clientId: readRequired(env, "FIC_CLIENT_ID"),
    clientSecret: readRequired(env, "FIC_CLIENT_SECRET"),
    redirectUri: readUrl(env, "FIC_REDIRECT_URI", null),
    authorizeUrl: readUrl(env, "FIC_OAUTH_AUTHORIZE_URL", FIC_DEFAULT_OAUTH_AUTHORIZE_URL),
    tokenUrl: readUrl(env, "FIC_OAUTH_TOKEN_URL", FIC_DEFAULT_OAUTH_TOKEN_URL),
  };
  if (env.FIC_OAUTH_REVOKE_URL?.trim()) config.revokeUrl = readUrl(env, "FIC_OAUTH_REVOKE_URL", null);
  return config;
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

/** Every secret of the request redacted from a FiC response body (longest first). */
function redactAll(text: string, secrets: readonly string[]): string {
  let excerpt = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) excerpt = redactExcerpt(excerpt, secret);
  return excerpt;
}

/** The RFC 6749 `error` code of an OAuth error body, when it is a plausible short code. */
function oauthErrorCode(body: Uint8Array): string | undefined {
  try {
    const json: unknown = JSON.parse(new TextDecoder().decode(body));
    const code = (json as { error?: unknown } | null)?.error;
    return typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

interface OAuthPost {
  url: string;
  /** JSON (the token endpoint of FiC) or form (RFC 7009 revocation). */
  encoding: "json" | "form";
  fields: Record<string, string>;
  /** Every secret in `fields`: redacted from any excerpt of the response. */
  secrets: readonly string[];
}

interface OAuthPostResult {
  status: number;
  headers: Headers;
  body: Uint8Array;
  tooLarge: boolean;
  path: string;
  details: { method: "POST"; path: string; attempts: 1 };
}

/**
 * One POST to an OAuth endpoint of FiC: no retry (a code, and a refresh token that FiC
 * rotates, are single use), no redirect followed, timeout on the whole response.
 * @throws FicServerError (5xx), FicOAuthHttpError (3xx, 4xx), FicNetworkError, FicTimeoutError.
 */
async function postOAuth(request: OAuthPost, options: ExchangeCodeOptions): Promise<OAuthPostResult> {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? FIC_OAUTH_TIMEOUT_MS;
  const path = new URL(request.url).pathname;
  const details = { method: "POST" as const, path, attempts: 1 as const };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(TIMEOUT), timeoutMs);
  let status: number;
  let headers: Headers;
  let body: Uint8Array;
  let tooLarge: boolean;
  try {
    const response = await doFetch(request.url, {
      method: "POST",
      headers: {
        "Content-Type": request.encoding === "json" ? "application/json" : "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: request.encoding === "json" ? JSON.stringify(request.fields) : new URLSearchParams(request.fields).toString(),
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

  if (status < 200 || status >= 300) {
    const bodyExcerpt = redactAll(new TextDecoder().decode(body), request.secrets);
    const label = `FiC POST ${path} answered ${status}`;
    if (status >= 500 && status < 600) throw new FicServerError(label, { ...details, status, bodyExcerpt });
    throw new FicOAuthHttpError(label, { ...details, status, bodyExcerpt, oauthError: oauthErrorCode(body) });
  }
  return { status, headers, body, tooLarge, path, details };
}

/** Validates a 2xx token response; a body holding tokens is never kept in an error, not even redacted. */
function parseTokenResponse<S extends z.ZodType>(result: OAuthPostResult, schema: S): z.output<S> {
  const { path, details, status } = result;
  const fail = (reason: string) =>
    new FicInvalidResponseError(`FiC POST ${path}: ${reason}`, { ...details, status, bodyExcerpt: "[REDACTED]" });
  if (result.tooLarge) throw fail(`response body larger than ${FIC_OAUTH_MAX_RESPONSE_BYTES} bytes`);
  if (!isJsonContentType(result.headers.get("content-type"))) throw fail("response is not JSON (Content-Type)");
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.body));
  } catch {
    throw fail("response body is not valid JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const where = parsed.error.issues
      .slice(0, 5)
      .map((issue) => issue.path.join(".") || "(root)")
      .join(", ");
    throw fail(`response does not match the expected schema at ${where}`);
  }
  return parsed.data;
}

/**
 * Exchanges an authorization code for the tokens (`grant_type=authorization_code`, with the
 * PKCE verifier), as a JSON POST to the token URL. Never retried: a code is single use.
 * Redirects are not followed. A 2xx body is validated with Zod, nothing partial is returned.
 * @throws FicInvalidArgumentError for a code that cannot be sent (nothing is sent).
 * @throws FicHttpError (4xx, as FicOAuthHttpError), FicServerError (5xx), FicInvalidResponseError
 *   (2xx not valid), FicNetworkError, FicTimeoutError: none of them carries a secret.
 */
export async function exchangeAuthorizationCode(
  config: FicOAuthConfig,
  params: { code: string; codeVerifier: string },
  options: ExchangeCodeOptions = {},
): Promise<FicOAuthTokens> {
  if (!isPlausibleAuthorizationCode(params.code)) throw new FicInvalidArgumentError("Authorization code malformed");
  const result = await postOAuth(
    {
      url: config.tokenUrl,
      encoding: "json",
      fields: {
        grant_type: "authorization_code",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        code: params.code,
        code_verifier: params.codeVerifier,
      },
      secrets: [config.clientSecret, params.code, params.codeVerifier],
    },
    options,
  );
  return parseTokenResponse(result, oauthTokenResponseSchema);
}

/** A token as stored by Vistato: visible ASCII, bounded (anything else is never sent). */
function isSendableToken(token: unknown): token is string {
  return typeof token === "string" && token.length <= FIC_OAUTH_TOKEN_MAX_LENGTH && /^[\x21-\x7e]+$/.test(token);
}

/**
 * Renews the access token (`grant_type=refresh_token`), as a JSON POST to the token URL like
 * the code exchange. Never retried: FiC may rotate the refresh token, so a lost answer must
 * not be followed by a second use of the old one. `refreshToken` of the result is null when
 * FiC did not send a new one (the old one stays valid).
 * @throws FicInvalidArgumentError for a token that cannot be sent (nothing is sent).
 * @throws FicOAuthHttpError (4xx, with `oauthError` e.g. `invalid_grant`), FicServerError,
 *   FicInvalidResponseError, FicNetworkError, FicTimeoutError: none carries a secret.
 */
export async function refreshAccessToken(
  config: FicOAuthConfig,
  params: { refreshToken: string },
  options: ExchangeCodeOptions = {},
): Promise<FicOAuthRefreshedTokens> {
  if (!isSendableToken(params.refreshToken)) throw new FicInvalidArgumentError("Refresh token malformed");
  const result = await postOAuth(
    {
      url: config.tokenUrl,
      encoding: "json",
      fields: {
        grant_type: "refresh_token",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: params.refreshToken,
      },
      secrets: [config.clientSecret, params.refreshToken],
    },
    options,
  );
  return parseTokenResponse(result, oauthRefreshResponseSchema);
}

/** Timeout of a revocation: it runs while the user waits for the unlink, and its outcome does not matter. */
export const FIC_OAUTH_REVOKE_TIMEOUT_MS = 5_000;

/**
 * Asks FiC to revoke a token (RFC 7009: form POST with `token`, `token_type_hint` and the
 * client credentials) at `config.revokeUrl`. Resolves on any 2xx; the body is ignored.
 * @throws FicConfigError when no revocation endpoint is configured (nothing is sent).
 * @throws FicInvalidArgumentError, FicOAuthHttpError, FicServerError, FicNetworkError,
 *   FicTimeoutError: none carries a secret.
 */
export async function revokeToken(
  config: FicOAuthConfig,
  params: { token: string; hint: "access_token" | "refresh_token" },
  options: ExchangeCodeOptions = {},
): Promise<void> {
  if (!config.revokeUrl) throw new FicConfigError("FIC_OAUTH_REVOKE_URL is not set");
  if (!isSendableToken(params.token)) throw new FicInvalidArgumentError("Token malformed");
  await postOAuth(
    {
      url: config.revokeUrl,
      encoding: "form",
      fields: {
        token: params.token,
        token_type_hint: params.hint,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      },
      secrets: [config.clientSecret, params.token],
    },
    { timeoutMs: FIC_OAUTH_REVOKE_TIMEOUT_MS, ...options },
  );
}
