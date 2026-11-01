/**
 * Typed errors of the Fatture in Cloud (FiC) client.
 *
 * SECURITY: no error ever carries the access token or the `Authorization` header. The
 * client never puts them in a message; the excerpt of a FiC response body is redacted
 * (token and any `Bearer ...` value), stripped of control characters (no log forging)
 * and truncated to {@link FIC_BODY_EXCERPT_MAX_BYTES}. No error keeps a reference to the
 * request, its headers or the low-level `cause` of a network failure.
 */

/** Max size, in UTF-8 bytes, of the FiC response body kept in an error. */
export const FIC_BODY_EXCERPT_MAX_BYTES = 1024;

const REDACTED = "[REDACTED]";

/** Shortest token prefix redacted when the excerpt is cut in the middle of the token. */
const MIN_PARTIAL_TOKEN = 4;

export type FicHttpMethod = "GET" | "POST";

export interface FicErrorDetails {
  method?: FicHttpMethod;
  /** Path of the API (e.g. `/c/1/company/info`), never the full URL with credentials or query. */
  path?: string;
  /** HTTP status of the last FiC response, if there was one. */
  status?: number;
  /** Number of attempts made (1 = no retry). */
  attempts?: number;
  /** Redacted and truncated excerpt of the last FiC response body. */
  bodyExcerpt?: string;
}

/** Base class: `instanceof FicError` catches every error of the client. */
export class FicError extends Error {
  readonly method?: FicHttpMethod;
  readonly path?: string;
  readonly status?: number;
  readonly attempts?: number;
  readonly bodyExcerpt?: string;

  constructor(message: string, details: FicErrorDetails = {}) {
    super(message);
    this.name = new.target.name;
    this.method = details.method;
    this.path = details.path;
    this.status = details.status;
    this.attempts = details.attempts;
    this.bodyExcerpt = details.bodyExcerpt;
  }

  /** Safe serialisation for logs (`JSON.stringify(error)`): only the fields above. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      method: this.method,
      path: this.path,
      status: this.status,
      attempts: this.attempts,
      bodyExcerpt: this.bodyExcerpt,
    };
  }
}

/** Invalid argument (token, companyId, path) rejected before any request is sent. */
export class FicInvalidArgumentError extends FicError {}

/** Invalid client configuration (e.g. `FIC_API_BASE_URL` not an http(s) URL). */
export class FicConfigError extends FicError {}

/** 401: token expired or revoked. Never retried: renewing the token is the caller's job. */
export class FicUnauthorizedError extends FicError {}

/** 403: the token has no access to the company or lacks a scope. Never retried. */
export class FicForbiddenError extends FicError {}

/** 404: resource not found. Never retried. */
export class FicNotFoundError extends FicError {}

/** 429 still answered after the last attempt. */
export class FicRateLimitedError extends FicError {
  /** Wait asked by the last `Retry-After` header (after the cap), if it was readable. */
  readonly retryAfterMs?: number;

  constructor(message: string, details: FicErrorDetails & { retryAfterMs?: number } = {}) {
    super(message, details);
    this.retryAfterMs = details.retryAfterMs;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), retryAfterMs: this.retryAfterMs };
  }
}

/** 5xx after the last attempt (or at once for a non-idempotent request). */
export class FicServerError extends FicError {}

/** Any other unexpected status (other 4xx, 3xx: redirects are never followed). */
export class FicHttpError extends FicError {}

/**
 * A 4xx (or 3xx) of an OAuth endpoint (`/oauth/token`, revocation), with the RFC 6749 `error`
 * code of the body when it had one (e.g. `invalid_grant`): a short code, never a secret.
 */
export class FicOAuthHttpError extends FicHttpError {
  readonly oauthError?: string;

  constructor(message: string, details: FicErrorDetails & { oauthError?: string } = {}) {
    super(message, details);
    this.oauthError = details.oauthError;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), oauthError: this.oauthError };
  }
}

/** The connection failed (DNS, refused, reset) before a complete response. */
export class FicNetworkError extends FicError {
  /** Low-level error code (e.g. `ECONNREFUSED`), when available. */
  readonly code?: string;

  constructor(message: string, details: FicErrorDetails & { code?: string } = {}) {
    super(message, details);
    this.code = details.code;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), code: this.code };
  }
}

/** No complete response within the configured timeout: the request was aborted. */
export class FicTimeoutError extends FicError {
  readonly timeoutMs?: number;

  constructor(message: string, details: FicErrorDetails & { timeoutMs?: number } = {}) {
    super(message, details);
    this.timeoutMs = details.timeoutMs;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), timeoutMs: this.timeoutMs };
  }
}

/** 2xx whose body is not the expected JSON (empty, not JSON, wrong Content-Type, schema mismatch, too large). */
export class FicInvalidResponseError extends FicError {}

/** Truncates to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // Step back over continuation bytes (10xxxxxx) so that no character is cut in half.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/** C0/C1 controls and line/paragraph separators become spaces: one excerpt = one log line. */
function withoutControlCharacters(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    out += isControl ? " " : char;
  }
  return out;
}

/** Shortest secret part (after a short `a/`-style prefix) redacted on its own. */
const MIN_SECRET_PART = 8;

/**
 * Forms in which FiC may echo the token: literal, with `/` escaped as `\/` (PHP
 * `json_encode`), URL-encoded (upper- and lower-case hex) and, for tokens shaped like
 * `a/<secret>`, the secret part alone (covers any other encoding of the prefix).
 * Longest first, so that a longer form is redacted before a form it contains.
 */
function tokenVariants(token: string): string[] {
  const encoded = encodeURIComponent(token);
  const variants = new Set([token, token.replaceAll("/", "\\/"), encoded, encoded.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())]);
  const secret = /^[^/]{1,8}\/(.+)$/.exec(token)?.[1];
  if (secret && secret.length >= MIN_SECRET_PART) {
    variants.add(secret);
    variants.add(encodeURIComponent(secret));
  }
  return [...variants].sort((a, b) => b.length - a.length);
}

/**
 * Makes a FiC response body safe for an error: control characters become spaces, the
 * token (in every form of {@link tokenVariants}) and every `Bearer <value>` are redacted,
 * a token prefix left at the end by the cut is redacted too, and the result is at most
 * {@link FIC_BODY_EXCERPT_MAX_BYTES}.
 */
export function redactExcerpt(text: string, token: string | undefined): string {
  let excerpt = truncateUtf8(withoutControlCharacters(text), FIC_BODY_EXCERPT_MAX_BYTES);
  if (token) {
    const variants = tokenVariants(token);
    for (const variant of variants) excerpt = excerpt.split(variant).join(REDACTED);
    // The cut may leave the start of any form at the end: redact the longest such prefix.
    let cut = 0;
    for (const variant of variants) {
      for (let k = Math.min(variant.length - 1, excerpt.length); k >= MIN_PARTIAL_TOKEN && k > cut; k--) {
        if (excerpt.endsWith(variant.slice(0, k))) {
          cut = k;
          break;
        }
      }
    }
    if (cut > 0) excerpt = excerpt.slice(0, -cut) + REDACTED;
  }
  excerpt = excerpt.replace(/\bBearer\s+\S+/gi, `Bearer ${REDACTED}`);
  // Redaction may have made it longer: cut again (cutting only removes text, never reveals it).
  return truncateUtf8(excerpt, FIC_BODY_EXCERPT_MAX_BYTES);
}
