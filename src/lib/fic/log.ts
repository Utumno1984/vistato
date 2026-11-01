/**
 * Structured log lines of the Fatture in Cloud link (token renewal, unlink, revocation).
 *
 * SECURITY: an entry has a closed set of fields, none of which can hold a token, a code, a
 * verifier or the client secret: identifiers, statuses and error names only. Never add a
 * free-text field fed with FiC data (a FiC error body may echo a token).
 */

export type FicLogLevel = "info" | "warn" | "error";

export interface FicLogEntry {
  level: FicLogLevel;
  /** What happened, e.g. `fic_token_refresh_rejected`. */
  event: string;
  tenantId?: string;
  connectionId?: string;
  userId?: string;
  companyId?: number | null;
  /** State of the link before the event. */
  status?: string;
  /** Name of the error class (e.g. `FicServerError`), never its message or body. */
  error?: string;
  /** HTTP status answered by FiC. */
  httpStatus?: number;
  /** RFC 6749 error code answered by FiC (e.g. `invalid_grant`), already checked to be a short code. */
  oauthError?: string;
  /** Whether FiC sent a new refresh token. */
  rotated?: boolean;
  /** Outcome of the revocation on unlink. */
  revocation?: string;
}

export type FicLogger = (entry: FicLogEntry) => void;

/** Default logger: one JSON line on the server console (stderr for warnings and errors). */
export const logFicEvent: FicLogger = (entry) => {
  const line = JSON.stringify({ at: new Date().toISOString(), scope: "fic", ...entry });
  if (entry.level === "info") console.info(line);
  else if (entry.level === "warn") console.warn(line);
  else console.error(line);
};
