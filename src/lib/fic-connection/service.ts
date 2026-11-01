import "server-only";

import { ValidationError, UserNotInTenantError } from "@/db/errors";
import type { FicConnection, TenantScope } from "@/db/tenant-scope";
import { FIC_MAX_AVAILABLE_COMPANIES } from "@/db/tenant-scope";
import { decryptSecret, encryptSecret, SecretBoxConfigError } from "@/lib/crypto/secret-box";
import { listCompanies as defaultListCompanies } from "@/lib/fic/client";
import { FicConfigError, FicError } from "@/lib/fic/errors";
import {
  buildAuthorizationUrl,
  createOAuthState,
  createPkcePair,
  exchangeAuthorizationCode,
  FIC_OAUTH_SCOPE,
  FIC_OAUTH_STATE_PATTERN,
  type FicOAuthConfig,
  isPlausibleAuthorizationCode,
  readFicOAuthConfig,
} from "@/lib/fic/oauth";
import type { FicCompany } from "@/lib/fic/schemas";

import type { FicCallbackOutcome } from "./outcomes";

/**
 * Linking a tenant to its Fatture in Cloud company (OAuth2 Authorization Code + PKCE).
 *
 * Callers are the API routes, after `requireSession` and `requireFicIbanAlert(..., "manage")`:
 * the tenant is always the session's (`caller.scope`), never an ID from the request. Secrets
 * (PKCE verifier, tokens) are encrypted here with the tenant of the scope as AAD before they
 * reach the data layer.
 */

/** Lifetime of an authorization request (`state`): 10 minutes, `expires_at` exclusive. */
export const FIC_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface FicConnectionCaller {
  user: { id: string };
  scope: Pick<TenantScope, "tenantId" | "ficConnection" | "ficOauthStates">;
}

export interface FicConnectionDeps {
  /** Current time (injectable for the boundary tests). */
  now?: () => Date;
  /** OAuth configuration; default from the environment (read at every call). */
  config?: FicOAuthConfig;
  /** `fetch` of the token exchange. */
  fetch?: typeof fetch;
  /** `GET /user/companies` with the new access token. */
  listCompanies?: (accessToken: string) => Promise<FicCompany[]>;
}

/** Fatture in Cloud is not configured on this server (OAuth variables or encryption key). */
export class FicNotConfiguredError extends Error {
  override name = "FicNotConfiguredError";
  constructor() {
    super("Fatture in Cloud OAuth is not configured");
  }
}

function config(deps: FicConnectionDeps): FicOAuthConfig {
  try {
    return deps.config ?? readFicOAuthConfig();
  } catch (error) {
    if (error instanceof FicConfigError) throw new FicNotConfiguredError();
    throw error;
  }
}

function encrypt(caller: FicConnectionCaller, plaintext: string, purpose: Parameters<typeof encryptSecret>[1]["purpose"]) {
  try {
    return encryptSecret(plaintext, { tenantId: caller.scope.tenantId, purpose });
  } catch (error) {
    if (error instanceof SecretBoxConfigError) throw new FicNotConfiguredError();
    throw error;
  }
}

export type StartFicConnectionResult = { authorizationUrl: string } | { error: "already_connected" };

/**
 * Starts the authorization: a new random `state` (256 bits) and PKCE pair, stored for the
 * caller (hash of the state, verifier encrypted), valid 10 minutes. Refused when the tenant
 * already has a connection, complete or waiting for the choice of the company.
 * @throws FicNotConfiguredError when the OAuth variables or the encryption key are missing.
 */
export async function startFicConnection(
  caller: FicConnectionCaller,
  deps: FicConnectionDeps = {},
): Promise<StartFicConnectionResult> {
  if (await caller.scope.ficConnection.get()) return { error: "already_connected" };
  const oauth = config(deps);
  const now = (deps.now ?? (() => new Date()))();
  const state = createOAuthState();
  const pkce = createPkcePair();
  await caller.scope.ficOauthStates.create({
    userId: caller.user.id,
    state,
    codeVerifierEnc: encrypt(caller, pkce.verifier, "fic_pkce_verifier"),
    expiresAt: new Date(now.getTime() + FIC_OAUTH_STATE_TTL_MS),
    now,
  });
  return { authorizationUrl: buildAuthorizationUrl(oauth, { state, codeChallenge: pkce.challenge }) };
}

/** The single value of a query parameter, or null when it is missing or repeated. */
function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : null;
}

/**
 * Completes the authorization from the callback query (`code`, `state`, or `error`). Order:
 * 1. the `state` must be one Vistato issued, unused, of this tenant: it is spent at once
 *    (single use, whatever happens next); then it must be the caller's and not expired.
 *    Until this passes FiC is never called and nothing is saved;
 * 2. `error` from FiC (`access_denied` = the user refused): nothing is saved;
 * 3. a tenant connected meanwhile: nothing is exchanged;
 * 4. code exchanged for the tokens (with the verifier), then `GET /user/companies`;
 * 5. one company: `connected`; several: `pending_company_selection`; none: `no_company`.
 *    A company linked to another tenant (unique constraint): `company_already_linked`, the
 *    tokens are discarded.
 * Returns the outcome code of the redirect; never throws for a FiC failure.
 */
export async function completeFicConnection(
  caller: FicConnectionCaller,
  query: URLSearchParams,
  deps: FicConnectionDeps = {},
): Promise<FicCallbackOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const state = single(query, "state");
  if (state === null || !FIC_OAUTH_STATE_PATTERN.test(state)) return "invalid_state";

  const request = await caller.scope.ficOauthStates.consume(state, now);
  if (!request || request.userId !== caller.user.id || now.getTime() >= request.expiresAt.getTime()) {
    return "invalid_state";
  }

  if (query.has("error")) return single(query, "error") === "access_denied" ? "access_denied" : "authorization_failed";

  if (await caller.scope.ficConnection.get()) return "already_connected";

  const code = single(query, "code");
  if (!isPlausibleAuthorizationCode(code)) return "token_exchange_failed";

  let codeVerifier: string;
  try {
    codeVerifier = decryptSecret(request.codeVerifierEnc, {
      tenantId: caller.scope.tenantId,
      purpose: "fic_pkce_verifier",
    }).plaintext;
  } catch {
    // Not decryptable for this tenant (or no key): as good as no request.
    return "invalid_state";
  }

  let oauth: FicOAuthConfig;
  try {
    oauth = config(deps);
  } catch {
    return "token_exchange_failed";
  }

  let tokens;
  try {
    tokens = await exchangeAuthorizationCode(oauth, { code, codeVerifier }, { fetch: deps.fetch });
  } catch (error) {
    if (error instanceof FicError) return "token_exchange_failed";
    throw error;
  }

  let companies: FicCompany[];
  try {
    companies = await (deps.listCompanies ?? defaultListCompanies)(tokens.accessToken);
  } catch (error) {
    if (error instanceof FicError) return "companies_failed";
    throw error;
  }
  if (companies.length === 0) return "no_company";
  if (companies.length > FIC_MAX_AVAILABLE_COMPANIES) return "companies_failed";

  try {
    const result = await caller.scope.ficConnection.create({
      accessTokenEnc: encrypt(caller, tokens.accessToken, "fic_access_token"),
      refreshTokenEnc: encrypt(caller, tokens.refreshToken, "fic_refresh_token"),
      accessTokenExpiresAt: new Date(now.getTime() + tokens.expiresInSeconds * 1000),
      scopes: FIC_OAUTH_SCOPE,
      companies,
      connectedByUserId: caller.user.id,
      at: now,
    });
    if (result.outcome === "created") return result.connection.status;
    return result.outcome;
  } catch (error) {
    if (error instanceof ValidationError) return "companies_failed";
    if (error instanceof UserNotInTenantError) return "invalid_state";
    if (error instanceof FicNotConfiguredError) return "token_exchange_failed";
    throw error;
  }
}

export type SelectFicCompanyOutcome =
  | { outcome: "connected"; connection: FicConnection }
  | { outcome: "not_pending" | "unknown_company" | "company_already_linked" };

/** Chooses the company of a `pending_company_selection` connection among its saved ones. */
export async function selectFicCompany(
  caller: FicConnectionCaller,
  companyId: number,
  deps: Pick<FicConnectionDeps, "now"> = {},
): Promise<SelectFicCompanyOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  return caller.scope.ficConnection.selectCompany(companyId, now);
}
