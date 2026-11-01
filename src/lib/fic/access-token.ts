import "server-only";

import { LockTimeoutError } from "@/db/errors";
import { forTenant, type FicStoredTokens, type FicTokensSnapshot, type TenantScope } from "@/db/tenant-scope";
import {
  decryptSecret,
  encryptSecret,
  SecretBoxConfigError,
  SecretDecryptionError,
  type SecretPurpose,
} from "@/lib/crypto/secret-box";
import { FicNotConfiguredError } from "@/lib/fic-connection/service";

import {
  FicConfigError,
  FicInvalidArgumentError,
  FicInvalidResponseError,
  FicNetworkError,
  FicOAuthHttpError,
  FicServerError,
  FicTimeoutError,
} from "./errors";
import { logFicEvent, type FicLogger } from "./log";
import { type FicOAuthConfig, readFicOAuthConfig, refreshAccessToken } from "./oauth";

/**
 * The single way to get a valid Fatture in Cloud access token for a tenant:
 * `getFicAccessToken(tenantId)`. Backfill, import and webhooks call it before every FiC
 * request; it renews the token when it is expired or about to expire.
 *
 * - Fast path: the stored token expires in more than {@link FIC_ACCESS_TOKEN_REFRESH_MARGIN_MS}
 *   → returned as it is, FiC is not called, no lock is taken.
 * - Renewal: under the lock of the tenant's connection row (`SELECT ... FOR UPDATE` in a
 *   transaction, `forTenant(tenantId).ficConnection.withTokenLock`), so that of concurrent
 *   callers in any number of processes only one calls FiC; the others wait and find the token
 *   it saved (checked again under the lock). Within a process, concurrent callers of the same
 *   tenant also share one renewal (one pooled connection waiting on the lock, not ten).
 * - FiC refuses the refresh token (`invalid_grant`, or a 400/401 that is not a configuration
 *   error of Vistato's client) → `reauthorization_required`, tokens deleted,
 *   {@link FicReauthorizationRequiredError}.
 * - FiC unavailable (5xx, timeout, network, 429, invalid answer) or the lock not obtained →
 *   nothing changes, {@link FicTokenRefreshUnavailableError} (retryable).
 * - FiC renewed the token but saving it failed → logged, `reauthorization_required` (the old
 *   refresh token may already be invalid), {@link FicReauthorizationRequiredError}; unless the
 *   row changed meanwhile (e.g. the commit did go through, or an unlink): then the error of the
 *   row as it is now (not connected, or retryable `save_conflict`).
 * - Database pool: the lock is a transaction, so a renewal holds a pooled connection for the
 *   whole FiC request (up to its timeout). A provider runs at most
 *   {@link FIC_MAX_CONCURRENT_RENEWALS} renewals at a time (of different tenants; the others wait
 *   for a slot without a connection, at most {@link FIC_RENEWAL_SLOT_WAIT_MS}): a slow or
 *   unreachable FiC cannot take the whole pool from the rest of the application.
 * - Backoff: after {@link FIC_RENEWAL_FAILURE_THRESHOLD} consecutive temporary failures of a
 *   tenant, its calls fail at once with the same retryable error for
 *   {@link FIC_RENEWAL_BACKOFF_MS} (injected clock), without asking FiC or the database lock.
 *   Nothing is written. Then one call tries again; a success clears the memory.
 *
 * Tenant isolation: every read and write goes through `forTenant(tenantId)` (lock and updates
 * filter on `tenant_id`); the tokens are decrypted and encrypted with AAD = the tenant.
 * Tokens never appear in an error or a log line.
 */

/** A token expiring within this margin (boundary included) is renewed before use. */
export const FIC_ACCESS_TOKEN_REFRESH_MARGIN_MS = 60_000;

/** Renewals (of different tenants) run at the same time by a provider: well below the pool (10). */
export const FIC_MAX_CONCURRENT_RENEWALS = 3;
/** Longest wait for a renewal slot before a retryable `lock_timeout`. */
export const FIC_RENEWAL_SLOT_WAIT_MS = 30_000;
/** Consecutive temporary failures of a tenant after which its renewals back off. */
export const FIC_RENEWAL_FAILURE_THRESHOLD = 2;
/** How long a tenant's renewals back off after repeated temporary failures. */
export const FIC_RENEWAL_BACKOFF_MS = 15_000;

/** OAuth error codes that mean Vistato's client is misconfigured, not that the grant is invalid. */
const CLIENT_CONFIGURATION_ERRORS: ReadonlySet<string> = new Set([
  "invalid_client",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_request",
]);

/** The tenant has no linked company (no connection, or still choosing the company). */
export class FicNotConnectedError extends Error {
  override name = "FicNotConnectedError";
  constructor() {
    super("The tenant has no Fatture in Cloud company linked");
  }
}

/** FiC refused the refresh token for good: the tokens are gone, an OWNER/ADMIN must link again. */
export class FicReauthorizationRequiredError extends Error {
  override name = "FicReauthorizationRequiredError";
  constructor() {
    super("The Fatture in Cloud link must be authorized again");
  }
}

export type FicTokenUnavailableReason =
  | "fic_server_error"
  | "fic_timeout"
  | "fic_network_error"
  | "fic_rate_limited"
  | "fic_invalid_response"
  | "lock_timeout"
  /** The renewed tokens were not saved, but the link was changed meanwhile by someone else. */
  | "save_conflict";

/** Temporary: the token could not be renewed now, nothing changed. Retry later. */
export class FicTokenRefreshUnavailableError extends Error {
  override name = "FicTokenRefreshUnavailableError";
  readonly retryable = true;
  constructor(
    readonly reason: FicTokenUnavailableReason,
    readonly httpStatus?: number,
  ) {
    super(`The Fatture in Cloud access token cannot be renewed now (${reason})`);
  }
}

/**
 * Not retryable, nothing changed: FiC answered the renewal in a way that points at Vistato's
 * configuration (e.g. `invalid_client`, 403, a redirect). The link is not dropped for it.
 */
export class FicTokenRefreshFailedError extends Error {
  override name = "FicTokenRefreshFailedError";
  readonly retryable = false;
  constructor(
    readonly httpStatus?: number,
    readonly oauthError?: string,
  ) {
    super(`Fatture in Cloud refused the token renewal${httpStatus ? ` (${httpStatus})` : ""}`);
  }
}

/**
 * Not retryable, nothing changed: the stored refresh token cannot be decrypted with the
 * configured keys (wrong or rotated key). The link is not dropped: fixing the key fixes it.
 */
export class FicTokenUnreadableError extends Error {
  override name = "FicTokenUnreadableError";
  readonly retryable = false;
  constructor() {
    super("The stored Fatture in Cloud token cannot be decrypted");
  }
}

export interface FicAccessTokenDeps {
  /** Current time (injectable for the margin boundary). */
  now?: () => Date;
  /** OAuth configuration; default from the environment. */
  config?: FicOAuthConfig;
  /** `fetch` of the renewal. */
  fetch?: typeof fetch;
  /** Timeout of the renewal request (default the OAuth timeout, 15 s). */
  timeoutMs?: number;
  log?: FicLogger;
  /**
   * Renew even if the stored token is still valid (e.g. FiC answered 401 to it). A token
   * renewed meanwhile by someone else is used instead of renewing again.
   */
  forceRefresh?: boolean;
}

export interface FicAccessTokenProviderOptions {
  /** Default {@link FIC_MAX_CONCURRENT_RENEWALS}. */
  maxConcurrentRenewals?: number;
  /** Default {@link FIC_RENEWAL_SLOT_WAIT_MS}. */
  slotWaitMs?: number;
  /** Default {@link FIC_RENEWAL_FAILURE_THRESHOLD}. */
  failureThreshold?: number;
  /** Default {@link FIC_RENEWAL_BACKOFF_MS}. */
  backoffMs?: number;
}

/**
 * Returns a valid access token of the tenant. Within a process the concurrent renewals of a
 * tenant are shared: the dependencies of the first caller are used for all of them.
 */
export type FicAccessTokenProvider = (tenantId: string, deps?: FicAccessTokenDeps) => Promise<string>;

type Scope = Pick<TenantScope, "tenantId" | "ficConnection">;
type UsableTokens = FicStoredTokens & { status: "connected" };

function assertUsable(tokens: FicStoredTokens | null): asserts tokens is UsableTokens {
  if (tokens === null || tokens.status === "pending_company_selection") throw new FicNotConnectedError();
  if (tokens.status === "reauthorization_required") throw new FicReauthorizationRequiredError();
}

function isFresh(tokens: FicStoredTokens, now: Date): boolean {
  const expiresAt = tokens.accessTokenExpiresAt;
  return expiresAt !== null && expiresAt.getTime() - now.getTime() > FIC_ACCESS_TOKEN_REFRESH_MARGIN_MS;
}

/** The plaintext, or null when it does not decrypt for this tenant and purpose. */
function decrypt(scope: Scope, encrypted: string | null, purpose: SecretPurpose): string | null {
  if (encrypted === null) return null;
  try {
    return decryptSecret(encrypted, { tenantId: scope.tenantId, purpose }).plaintext;
  } catch (error) {
    if (error instanceof SecretDecryptionError) return null;
    if (error instanceof SecretBoxConfigError) throw new FicNotConfiguredError();
    throw error;
  }
}

function encrypt(scope: Scope, plaintext: string, purpose: SecretPurpose): string {
  return encryptSecret(plaintext, { tenantId: scope.tenantId, purpose });
}

function oauthConfig(deps: FicAccessTokenDeps): FicOAuthConfig {
  try {
    return deps.config ?? readFicOAuthConfig();
  } catch (error) {
    if (error instanceof FicConfigError) throw new FicNotConfiguredError();
    throw error;
  }
}

/** FiC refused the grant itself (as opposed to a configuration error of Vistato's client). */
function isRejectedGrant(error: unknown): error is FicOAuthHttpError {
  if (!(error instanceof FicOAuthHttpError)) return false;
  if (error.status !== 400 && error.status !== 401) return false;
  return error.oauthError === undefined || !CLIENT_CONFIGURATION_ERRORS.has(error.oauthError);
}

/** A renewal error that changes nothing, as the error the caller gets. */
function unchangedError(error: unknown): Error | null {
  if (error instanceof FicServerError) return new FicTokenRefreshUnavailableError("fic_server_error", error.status);
  if (error instanceof FicTimeoutError) return new FicTokenRefreshUnavailableError("fic_timeout");
  if (error instanceof FicNetworkError) return new FicTokenRefreshUnavailableError("fic_network_error");
  if (error instanceof FicInvalidResponseError) return new FicTokenRefreshUnavailableError("fic_invalid_response", error.status);
  if (error instanceof FicOAuthHttpError) {
    if (error.status === 429) return new FicTokenRefreshUnavailableError("fic_rate_limited", 429);
    return new FicTokenRefreshFailedError(error.status, error.oauthError);
  }
  // A stored refresh token that cannot even be sent is as good as unreadable.
  if (error instanceof FicInvalidArgumentError) return new FicTokenUnreadableError();
  return null;
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);

type LockedOutcome =
  | { kind: "token"; token: string; renewed: false }
  | { kind: "token"; token: string; renewed: true; rotated: boolean }
  | { kind: "reauthorization_required" };

/**
 * @param seenAccessTokenEnc the access token the caller found before deciding to renew: under
 *   the lock, a different one still valid has just been renewed by someone else and is used as it
 *   is (even if its lifetime is within the margin, or with `forceRefresh`).
 */
async function renewUnderLock(scope: Scope, deps: FicAccessTokenDeps, seenAccessTokenEnc: string | null): Promise<string> {
  const log = deps.log ?? logFicEvent;
  const now = deps.now ?? (() => new Date());
  const config = oauthConfig(deps);
  // Set once FiC has issued new tokens: from then on any failure means "saving failed".
  const progress: { renewedFrom?: FicTokensSnapshot; at?: Date } = {};

  let outcome: LockedOutcome;
  try {
    outcome = await scope.ficConnection.withTokenLock(async (lock): Promise<LockedOutcome> => {
      const tokens = lock.tokens;
      assertUsable(tokens);
      const at = now();
      // Renewed meanwhile by the holder of the lock before us (another request or process).
      const renewedByOther =
        tokens.accessTokenEnc !== seenAccessTokenEnc &&
        tokens.accessTokenExpiresAt !== null &&
        tokens.accessTokenExpiresAt.getTime() > at.getTime();
      if (renewedByOther || (!deps.forceRefresh && isFresh(tokens, at))) {
        const token = decrypt(scope, tokens.accessTokenEnc, "fic_access_token");
        if (token !== null) return { kind: "token", token, renewed: false };
      }

      const refreshToken = decrypt(scope, tokens.refreshTokenEnc, "fic_refresh_token");
      if (refreshToken === null || tokens.accessTokenEnc === null || tokens.refreshTokenEnc === null) {
        log({ level: "error", event: "fic_token_unreadable", tenantId: scope.tenantId, connectionId: tokens.connectionId });
        throw new FicTokenUnreadableError();
      }

      let fresh;
      try {
        fresh = await refreshAccessToken(config, { refreshToken }, { fetch: deps.fetch, timeoutMs: deps.timeoutMs });
      } catch (error) {
        if (isRejectedGrant(error)) {
          await lock.requireReauthorization("refresh_rejected", at);
          log({
            level: "warn",
            event: "fic_token_refresh_rejected",
            tenantId: scope.tenantId,
            connectionId: tokens.connectionId,
            companyId: tokens.companyId,
            httpStatus: error.status,
            oauthError: error.oauthError,
          });
          return { kind: "reauthorization_required" };
        }
        const mapped = unchangedError(error);
        if (!mapped) throw error;
        log({
          level: mapped instanceof FicTokenRefreshUnavailableError ? "warn" : "error",
          event: "fic_token_refresh_failed",
          tenantId: scope.tenantId,
          connectionId: tokens.connectionId,
          error: errorName(error),
          httpStatus: error instanceof FicOAuthHttpError || error instanceof FicServerError ? error.status : undefined,
          oauthError: error instanceof FicOAuthHttpError ? error.oauthError : undefined,
        });
        throw mapped;
      }

      progress.renewedFrom = {
        connectionId: tokens.connectionId,
        accessTokenEnc: tokens.accessTokenEnc,
        refreshTokenEnc: tokens.refreshTokenEnc,
      };
      progress.at = at;
      await lock.saveRefreshedTokens({
        accessTokenEnc: encrypt(scope, fresh.accessToken, "fic_access_token"),
        // No new refresh token from FiC: the stored one stays in use.
        refreshTokenEnc: fresh.refreshToken === null ? undefined : encrypt(scope, fresh.refreshToken, "fic_refresh_token"),
        accessTokenExpiresAt: new Date(at.getTime() + fresh.expiresInSeconds * 1000),
      });
      return { kind: "token", token: fresh.accessToken, renewed: true, rotated: fresh.refreshToken !== null };
    });
  } catch (error) {
    if (progress.renewedFrom && progress.at) {
      // FiC has issued new tokens that are not saved (or not known to be): the stored refresh
      // token may already be invalid. Drop the link, unless someone changed it meanwhile.
      log({
        level: "error",
        event: "fic_token_save_failed",
        tenantId: scope.tenantId,
        connectionId: progress.renewedFrom.connectionId,
        error: errorName(error),
      });
      try {
        const marked = await scope.ficConnection.requireReauthorizationIfUnchanged(
          progress.renewedFrom,
          "save_failed",
          progress.at,
        );
        if (!marked) {
          // Changed meanwhile (an unlink, a new link, or our commit did go through after all):
          // the error of the row as it is now.
          const current = await scope.ficConnection.readTokens();
          assertUsable(current);
          throw new FicTokenRefreshUnavailableError("save_conflict");
        }
      } catch (markError) {
        if (
          markError instanceof FicNotConnectedError ||
          markError instanceof FicReauthorizationRequiredError ||
          markError instanceof FicTokenRefreshUnavailableError
        ) {
          throw markError;
        }
        log({
          level: "error",
          event: "fic_token_reauthorization_not_saved",
          tenantId: scope.tenantId,
          connectionId: progress.renewedFrom.connectionId,
          error: errorName(markError),
        });
      }
      throw new FicReauthorizationRequiredError();
    }
    if (error instanceof LockTimeoutError) {
      log({ level: "warn", event: "fic_token_lock_timeout", tenantId: scope.tenantId });
      throw new FicTokenRefreshUnavailableError("lock_timeout");
    }
    throw error;
  }

  if (outcome.kind === "reauthorization_required") throw new FicReauthorizationRequiredError();
  if (outcome.renewed) {
    log({ level: "info", event: "fic_token_refreshed", tenantId: scope.tenantId, rotated: outcome.rotated });
  }
  return outcome.token;
}

/**
 * A provider with its own in-process sharing of renewals, renewal slots and failure memory (one
 * per process in production: {@link getFicAccessToken}). Tests create several to play the part
 * of several processes.
 */
export function createFicAccessTokenProvider(options: FicAccessTokenProviderOptions = {}): FicAccessTokenProvider {
  const renewals = new Map<string, Promise<string>>();
  const failures = new Map<string, FailureMemory>();
  const slots = createSlots(
    options.maxConcurrentRenewals ?? FIC_MAX_CONCURRENT_RENEWALS,
    options.slotWaitMs ?? FIC_RENEWAL_SLOT_WAIT_MS,
  );
  const threshold = options.failureThreshold ?? FIC_RENEWAL_FAILURE_THRESHOLD;
  const backoffMs = options.backoffMs ?? FIC_RENEWAL_BACKOFF_MS;

  async function renew(key: string, scope: Scope, deps: FicAccessTokenDeps, seen: string | null): Promise<string> {
    const now = deps.now ?? (() => new Date());
    try {
      const token = await slots.run(() => renewUnderLock(scope, deps, seen));
      failures.delete(key);
      return token;
    } catch (error) {
      if (error instanceof FicTokenRefreshUnavailableError && isFicFailure(error)) {
        const count = (failures.get(key)?.count ?? 0) + 1;
        failures.set(key, { count, error, until: count >= threshold ? now().getTime() + backoffMs : undefined });
      } else {
        failures.delete(key);
      }
      throw error;
    }
  }

  return async (tenantId, deps = {}) => {
    const scope = forTenant(tenantId);
    const now = deps.now ?? (() => new Date());

    const stored = await scope.ficConnection.readTokens();
    assertUsable(stored);
    if (!deps.forceRefresh && isFresh(stored, now())) {
      const token = decrypt(scope, stored.accessTokenEnc, "fic_access_token");
      if (token !== null) return token;
      // Not decryptable (e.g. wrong key): the renewal decides, with the refresh token.
    }

    const key = scope.tenantId.toLowerCase();
    let renewal = renewals.get(key);
    if (!renewal) {
      const failed = failures.get(key);
      if (failed?.until !== undefined && now().getTime() < failed.until) {
        // FiC failed repeatedly just now: do not ask it again (nor take the lock) yet.
        throw new FicTokenRefreshUnavailableError(failed.error.reason, failed.error.httpStatus);
      }
      renewal = renew(key, scope, deps, stored.accessTokenEnc).finally(() => renewals.delete(key));
      renewals.set(key, renewal);
    }
    return renewal;
  };
}

/** A temporary failure of FiC itself (not of the lock or of a concurrent change). */
function isFicFailure(error: FicTokenRefreshUnavailableError): boolean {
  return error.reason !== "lock_timeout" && error.reason !== "save_conflict";
}

/** A counting semaphore whose waiters hold no connection and give up after `waitMs`. */
function createSlots(max: number, waitMs: number) {
  let used = 0;
  const waiting: (() => void)[] = [];

  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else used -= 1;
  };

  const acquire = (): Promise<void> => {
    if (used < max) {
      used += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = waiting.indexOf(grant);
        if (index >= 0) waiting.splice(index, 1);
        reject(new FicTokenRefreshUnavailableError("lock_timeout"));
      }, waitMs);
      waiting.push(grant);
    });
  };

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

interface FailureMemory {
  count: number;
  error: FicTokenRefreshUnavailableError;
  /** Until when (epoch ms) the tenant's renewals fail at once; set from the threshold on. */
  until?: number;
}

const defaultProvider = createFicAccessTokenProvider();

/**
 * A valid FiC access token of the tenant (see the module comment).
 * @throws ValidationError when `tenantId` is not a UUID.
 * @throws FicNotConnectedError, FicReauthorizationRequiredError, FicTokenRefreshUnavailableError
 *   (retryable), FicTokenRefreshFailedError, FicTokenUnreadableError, FicNotConfiguredError.
 */
export function getFicAccessToken(tenantId: string, deps: FicAccessTokenDeps = {}): Promise<string> {
  return defaultProvider(tenantId, deps);
}
