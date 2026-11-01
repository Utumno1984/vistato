import { createHash } from "node:crypto";

import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "@/db/client";
import {
  isForeignKeyViolation,
  isLockNotAvailable,
  isUniqueViolation,
  LockTimeoutError,
  UserNotInTenantError,
  ValidationError,
} from "@/db/errors";
import { FIC_REFRESH_ERRORS, ficConnections, ficOauthStates, type FicConnectionRow } from "@/db/schema";

import type { TenantId } from "./tenant-id";

/*
 * Fatture in Cloud link of one tenant: the OAuth authorization requests (`fic_oauth_states`)
 * and the connection itself (`fic_connections`). Every statement filters on (or sets)
 * `tenant_id`.
 *
 * Secrets arrive here already encrypted (`*Enc`; `src/lib/fic-connection/service.ts` and
 * `src/lib/fic/access-token.ts` encrypt with this scope's tenant as AAD): the data layer cannot
 * import the `server-only` secret box, since scripts and e2e helpers load it outside Next.
 * `get()` never returns a token, encrypted or not; the encrypted tokens come out only of
 * `readTokens`, `withTokenLock` and `disconnect`, for the code that decrypts them for this
 * tenant (access token renewal, revocation on unlink).
 */

const TENANT_UNIQUE = "fic_connections_tenant_id_unique";
const COMPANY_UNIQUE = "fic_connections_fic_company_id_unique";
const STATE_USER_FK = "fic_oauth_states_user_id_tenant_id_users_fk";
const CONNECTION_USER_FK = "fic_connections_connected_by_user_id_tenant_id_users_fk";

/** Anti-abuse cap on the companies of one FiC user kept while waiting for the choice. */
export const FIC_MAX_AVAILABLE_COMPANIES = 1000;
/** Same cap as the FiC client schemas on names coming from FiC. */
const FIC_COMPANY_NAME_MAX_LENGTH = 500;
/** Cap on an encrypted value (a secret of 8 KB encrypts to about 11 KB). */
const ENCRYPTED_MAX_LENGTH = 16 * 1024;
/** Cap on the raw `state` hashed for a lookup. */
const STATE_MAX_LENGTH = 8 * 1024;

export type FicConnectionStatus = FicConnectionRow["status"];
export type FicRefreshError = (typeof FIC_REFRESH_ERRORS)[number];

/**
 * Longest wait for the lock of the tenant's connection row (another request renewing the token
 * holds it for at most the FiC timeout): past it the caller gets a `LockTimeoutError`.
 */
export const FIC_TOKEN_LOCK_TIMEOUT_MS = 30_000;

/** A FiC company the user can link (`id` is the FiC company id). */
export interface FicCompanyChoice {
  id: number;
  name: string;
}

export const ficCompanyChoiceSchema = z.object({
  id: z.number().int().positive(),
  name: z
    .string()
    .max(FIC_COMPANY_NAME_MAX_LENGTH)
    .refine((value) => value.trim() !== "", { message: "must not be blank" })
    // Postgres text and jsonb cannot hold NUL or a lone surrogate.
    .refine((value) => value.isWellFormed() && !value.includes("\u0000"), { message: "invalid characters" }),
});

/** Validation of `available_companies` both on write and on read (jsonb is never trusted). */
const companyChoicesSchema = z.array(ficCompanyChoiceSchema).min(1).max(FIC_MAX_AVAILABLE_COMPANIES);

/** The connection as seen by application code: never a token, encrypted or not. */
export interface FicConnection {
  id: string;
  status: FicConnectionStatus;
  companyId: number | null;
  companyName: string | null;
  /** Only in `pending_company_selection`; null otherwise. */
  availableCompanies: FicCompanyChoice[] | null;
  scopes: string;
  /** Null exactly in `reauthorization_required` (no token any more). */
  accessTokenExpiresAt: Date | null;
  connectedByUserId: string;
  connectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The encrypted tokens of the tenant's connection (AAD = this tenant), for the code that
 * renews or revokes them. Never part of an API resource.
 */
export interface FicStoredTokens {
  connectionId: string;
  status: FicConnectionStatus;
  companyId: number | null;
  /** Null in `reauthorization_required`. */
  accessTokenEnc: string | null;
  refreshTokenEnc: string | null;
  accessTokenExpiresAt: Date | null;
}

/** The tenant's connection row, locked (`SELECT ... FOR UPDATE`) until the callback ends. */
export interface FicTokenLock {
  /** The row as read under the lock; null when the tenant has no connection. */
  readonly tokens: FicStoredTokens | null;
  /**
   * Saves the renewed tokens of the locked `connected` row. `refreshTokenEnc` absent (FiC did
   * not rotate it): the stored refresh token stays. Clears any previous refresh error.
   * @throws ValidationError for an invalid input; Error when the locked row is not `connected`.
   */
  saveRefreshedTokens(input: SaveRefreshedTokensInput): Promise<void>;
  /**
   * The locked `connected` row goes to `reauthorization_required`: tokens and expiry deleted,
   * error and instant recorded. False when the row is not `connected` (nothing changes).
   */
  requireReauthorization(error: FicRefreshError, at: Date): Promise<boolean>;
}

export type DisconnectFicResult =
  | { outcome: "not_connected" }
  /** The row is deleted; its last encrypted tokens are returned for the revocation (null in `reauthorization_required`). */
  | {
      outcome: "disconnected";
      previous: Pick<FicStoredTokens, "status" | "companyId" | "accessTokenEnc" | "refreshTokenEnc">;
    };

const encryptedSchema = z.string().min(1).max(ENCRYPTED_MAX_LENGTH);
const validDate = z.date().refine((d) => !Number.isNaN(d.getTime()), "Data non valida");

export const createFicConnectionInputSchema = z.object({
  /** Encrypted for this tenant, purpose `fic_access_token`. */
  accessTokenEnc: encryptedSchema,
  /** Encrypted for this tenant, purpose `fic_refresh_token`. */
  refreshTokenEnc: encryptedSchema,
  accessTokenExpiresAt: validDate,
  scopes: z.string().min(1).max(1000),
  companies: companyChoicesSchema,
  connectedByUserId: z.uuid(),
  at: validDate,
});

export type CreateFicConnectionInput = z.input<typeof createFicConnectionInputSchema>;

export const saveRefreshedTokensInputSchema = z.object({
  /** Encrypted for this tenant, purpose `fic_access_token`. */
  accessTokenEnc: encryptedSchema,
  /** Encrypted for this tenant, purpose `fic_refresh_token`; absent when FiC did not rotate it. */
  refreshTokenEnc: encryptedSchema.optional(),
  accessTokenExpiresAt: validDate,
});

export type SaveRefreshedTokensInput = z.input<typeof saveRefreshedTokensInputSchema>;

/** The encrypted values read before a renewal, compared again before dropping them. */
export interface FicTokensSnapshot {
  connectionId: string;
  accessTokenEnc: string;
  refreshTokenEnc: string;
}

export type CreateFicConnectionResult =
  | { outcome: "created"; connection: FicConnection }
  /** The tenant already has a connection (`connected` or pending): nothing changed. */
  | { outcome: "already_connected" }
  /** The only company is linked to another tenant: nothing was saved (the tokens are discarded). */
  | { outcome: "company_already_linked" };

export type SelectFicCompanyResult =
  | { outcome: "connected"; connection: FicConnection }
  /** No connection waiting for the choice of the company (none, or already connected). */
  | { outcome: "not_pending" }
  /** The company is not among the saved choices: nothing changed. */
  | { outcome: "unknown_company" }
  /** The company is linked to another tenant: the pending connection and its tokens are deleted. */
  | { outcome: "company_already_linked" };

export interface TenantFicConnection {
  /** The tenant's connection without any secret, or null when the tenant is not connected. */
  get(): Promise<FicConnection | null>;
  /**
   * Saves the link at the end of the OAuth callback: `connected` to the company when
   * `companies` has exactly one distinct entry, otherwise `pending_company_selection` with
   * the choices. The uniqueness of the tenant and of the company is enforced by the database
   * (concurrent callbacks or tenants: one wins, the others save nothing). A connection in
   * `reauthorization_required` (no token) is replaced, in the same transaction: when the new
   * link fails (e.g. the company belongs to another tenant) the old row stays as it was.
   * @throws ValidationError for an invalid input (nothing is saved).
   * @throws UserNotInTenantError when `connectedByUserId` is not a user of the tenant.
   */
  create(input: CreateFicConnectionInput): Promise<CreateFicConnectionResult>;
  /**
   * Completes a `pending_company_selection` connection with one of its saved companies.
   * A company linked meanwhile to another tenant (unique constraint) deletes the pending
   * connection: its tokens are discarded and the tenant is back to "not connected".
   */
  selectCompany(companyId: number, at?: Date): Promise<SelectFicCompanyResult>;
  /** The encrypted tokens without any lock (fast path of the renewal), or null. */
  readTokens(): Promise<FicStoredTokens | null>;
  /**
   * Runs `fn` in a transaction holding the lock of the tenant's connection row (`SELECT ...
   * FOR UPDATE`, filtered on the tenant): of concurrent renewals of the same tenant, in any
   * process, one runs at a time and the next ones see what the previous one saved. An unlink
   * (`disconnect`) waits for it too. The transaction commits when `fn` resolves and rolls back
   * when it throws. `fn` must use only the lock's operations (it holds a pooled connection).
   * @throws LockTimeoutError when the lock is not obtained within {@link FIC_TOKEN_LOCK_TIMEOUT_MS}.
   */
  withTokenLock<T>(fn: (lock: FicTokenLock) => Promise<T>): Promise<T>;
  /**
   * Outside any lock: `connected` → `reauthorization_required` (tokens deleted), only if the
   * row still holds exactly the encrypted tokens of `expected` (nobody renewed or unlinked it
   * meanwhile). For a renewal whose save failed. Returns whether the row changed.
   */
  requireReauthorizationIfUnchanged(expected: FicTokensSnapshot, error: FicRefreshError, at: Date): Promise<boolean>;
  /**
   * Unlinks the tenant: deletes its connection row, whatever its status (waiting for a renewal
   * in progress to commit), and returns the last encrypted tokens for their revocation. The
   * company is then free for another tenant. Other tenants' rows are never touched.
   */
  disconnect(): Promise<DisconnectFicResult>;
}

/** A consumed authorization request. */
export interface ConsumedFicOauthState {
  userId: string;
  expiresAt: Date;
  /** The PKCE `code_verifier`, encrypted for this tenant (purpose `fic_pkce_verifier`). */
  codeVerifierEnc: string;
}

export const createFicOauthStateInputSchema = z.object({
  userId: z.uuid(),
  state: z.string().min(1).max(STATE_MAX_LENGTH),
  codeVerifierEnc: encryptedSchema,
  expiresAt: validDate,
  now: validDate,
});

export type CreateFicOauthStateInput = z.input<typeof createFicOauthStateInputSchema>;

export interface TenantFicOauthStates {
  /**
   * Stores an authorization request (only the SHA-256 of `state`). In the same transaction it
   * deletes the tenant's requests already expired at `now`, used or not: they can no longer
   * be accepted, so the table holds at most the last 10 minutes of requests of a tenant.
   * @throws ValidationError for an invalid input.
   * @throws UserNotInTenantError when the user is not in the tenant.
   */
  create(input: CreateFicOauthStateInput): Promise<void>;
  /**
   * Marks the tenant's request with this `state` as used, in a single conditional UPDATE (of
   * two concurrent callbacks only one gets it), and returns it; null when the tenant has no
   * unused request with this `state` (unknown, already used, another tenant's). The caller
   * still checks the user and the expiry: the request is spent anyway (single use).
   */
  consume(state: string, now: Date): Promise<ConsumedFicOauthState | null>;
}

export function hashFicOauthState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  return parsed.data;
}

function toConnection(row: FicConnectionRow): FicConnection {
  let availableCompanies: FicCompanyChoice[] | null = null;
  if (row.availableCompanies !== null) {
    const parsed = companyChoicesSchema.safeParse(row.availableCompanies);
    // A corrupted value offers no choice rather than unvalidated data.
    availableCompanies = parsed.success ? parsed.data : [];
  }
  return {
    id: row.id,
    status: row.status,
    companyId: row.ficCompanyId,
    companyName: row.companyName,
    availableCompanies,
    scopes: row.scopes,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
    connectedByUserId: row.connectedByUserId,
    connectedAt: row.connectedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toStoredTokens(row: FicConnectionRow): FicStoredTokens {
  return {
    connectionId: row.id,
    status: row.status,
    companyId: row.ficCompanyId,
    accessTokenEnc: row.accessTokenEnc,
    refreshTokenEnc: row.refreshTokenEnc,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
  };
}

const refreshErrorSchema = z.enum(FIC_REFRESH_ERRORS);

/** The columns written when a `connected` row loses its tokens for good. */
function reauthorizationValues(error: FicRefreshError, at: Date) {
  return {
    status: "reauthorization_required" as const,
    accessTokenEnc: null,
    refreshTokenEnc: null,
    accessTokenExpiresAt: null,
    lastRefreshError: parse(refreshErrorSchema, error),
    lastRefreshErrorAt: parse(validDate, at),
  };
}

/** Distinct companies by id (the first occurrence wins), in the order received. */
function distinctCompanies(companies: readonly FicCompanyChoice[]): FicCompanyChoice[] {
  const byId = new Map<number, FicCompanyChoice>();
  for (const { id, name } of companies) if (!byId.has(id)) byId.set(id, { id, name });
  return [...byId.values()];
}

export function tenantFicConnection(db: Database, tenantId: TenantId): TenantFicConnection {
  const inTenant = eq(ficConnections.tenantId, tenantId);

  return {
    async get() {
      const [row] = await db.select().from(ficConnections).where(inTenant).limit(1);
      return row ? toConnection(row) : null;
    },

    async create(input) {
      const parsed = parse(createFicConnectionInputSchema, input);
      const choices = distinctCompanies(parsed.companies);
      const single = choices.length === 1 ? choices[0] : null;
      try {
        const row = await db.transaction(async (tx) => {
          // A link to redo: replaced by the new one, atomically (a failed insert keeps it).
          await tx
            .delete(ficConnections)
            .where(and(inTenant, eq(ficConnections.status, "reauthorization_required")));
          const [inserted] = await tx
          .insert(ficConnections)
          .values({
            tenantId,
            accessTokenEnc: parsed.accessTokenEnc,
            refreshTokenEnc: parsed.refreshTokenEnc,
            accessTokenExpiresAt: parsed.accessTokenExpiresAt,
            scopes: parsed.scopes,
            connectedByUserId: parsed.connectedByUserId,
            ...(single
              ? {
                  status: "connected" as const,
                  ficCompanyId: single.id,
                  companyName: single.name,
                  availableCompanies: null,
                  connectedAt: parsed.at,
                }
              : {
                  status: "pending_company_selection" as const,
                  ficCompanyId: null,
                  companyName: null,
                  availableCompanies: choices,
                  connectedAt: null,
                }),
          })
          .returning();
          return inserted;
        });
        return { outcome: "created", connection: toConnection(row) };
      } catch (error) {
        if (isUniqueViolation(error, TENANT_UNIQUE)) return { outcome: "already_connected" };
        if (isUniqueViolation(error, COMPANY_UNIQUE)) return { outcome: "company_already_linked" };
        if (isForeignKeyViolation(error, CONNECTION_USER_FK)) throw new UserNotInTenantError(parsed.connectedByUserId);
        throw error;
      }
    },

    async selectCompany(companyId, at = new Date()) {
      const [row] = await db.select().from(ficConnections).where(inTenant).limit(1);
      if (!row || row.status !== "pending_company_selection") return { outcome: "not_pending" };
      const chosen = toConnection(row).availableCompanies?.find((choice) => choice.id === companyId);
      if (!chosen) return { outcome: "unknown_company" };

      // Same row, still pending: of two concurrent choices only one completes it.
      const pendingRow = and(
        inTenant,
        eq(ficConnections.id, row.id),
        eq(ficConnections.status, "pending_company_selection"),
      );
      try {
        const [updated] = await db
          .update(ficConnections)
          .set({
            status: "connected",
            ficCompanyId: chosen.id,
            companyName: chosen.name,
            availableCompanies: null,
            connectedAt: at,
          })
          .where(pendingRow)
          .returning();
        return updated ? { outcome: "connected", connection: toConnection(updated) } : { outcome: "not_pending" };
      } catch (error) {
        if (!isUniqueViolation(error, COMPANY_UNIQUE)) throw error;
        // The company belongs to another tenant: the tokens of this attempt are discarded.
        await db.delete(ficConnections).where(pendingRow);
        return { outcome: "company_already_linked" };
      }
    },

    async readTokens() {
      const [row] = await db.select().from(ficConnections).where(inTenant).limit(1);
      return row ? toStoredTokens(row) : null;
    },

    async withTokenLock(fn) {
      try {
        return await db.transaction(async (tx) => {
          // Bounded wait for a renewal in progress elsewhere (SET LOCAL takes no parameter).
          await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${FIC_TOKEN_LOCK_TIMEOUT_MS}ms'`));
          const [row] = await tx.select().from(ficConnections).where(inTenant).limit(1).for("update");
          const tokens = row ? toStoredTokens(row) : null;
          const lockedConnected = row
            ? and(inTenant, eq(ficConnections.id, row.id), eq(ficConnections.status, "connected"))
            : undefined;

          const lock: FicTokenLock = {
            tokens,
            async saveRefreshedTokens(input) {
              const parsed = parse(saveRefreshedTokensInputSchema, input);
              if (!lockedConnected) throw new Error("No connection to save the renewed tokens to");
              const updated = await tx
                .update(ficConnections)
                .set({
                  accessTokenEnc: parsed.accessTokenEnc,
                  ...(parsed.refreshTokenEnc !== undefined ? { refreshTokenEnc: parsed.refreshTokenEnc } : {}),
                  accessTokenExpiresAt: parsed.accessTokenExpiresAt,
                  lastRefreshError: null,
                  lastRefreshErrorAt: null,
                })
                .where(lockedConnected)
                .returning({ id: ficConnections.id });
              if (updated.length !== 1) throw new Error("The locked connection is not connected");
            },
            async requireReauthorization(error, at) {
              if (!lockedConnected) return false;
              const updated = await tx
                .update(ficConnections)
                .set(reauthorizationValues(error, at))
                .where(lockedConnected)
                .returning({ id: ficConnections.id });
              return updated.length === 1;
            },
          };
          return fn(Object.freeze(lock));
        });
      } catch (error) {
        if (isLockNotAvailable(error)) throw new LockTimeoutError();
        throw error;
      }
    },

    async requireReauthorizationIfUnchanged(expected, error, at) {
      const updated = await db
        .update(ficConnections)
        .set(reauthorizationValues(error, at))
        .where(
          and(
            inTenant,
            eq(ficConnections.id, expected.connectionId),
            eq(ficConnections.status, "connected"),
            eq(ficConnections.accessTokenEnc, expected.accessTokenEnc),
            eq(ficConnections.refreshTokenEnc, expected.refreshTokenEnc),
          ),
        )
        .returning({ id: ficConnections.id });
      return updated.length === 1;
    },

    async disconnect() {
      // A plain DELETE waits for the row lock of a renewal in progress and then deletes (and
      // returns) the row as that renewal left it: the latest tokens are the ones revoked.
      const [row] = await db.delete(ficConnections).where(inTenant).returning();
      if (!row) return { outcome: "not_connected" };
      const { status, companyId, accessTokenEnc, refreshTokenEnc } = toStoredTokens(row);
      return { outcome: "disconnected", previous: { status, companyId, accessTokenEnc, refreshTokenEnc } };
    },
  };
}

export function tenantFicOauthStates(db: Database, tenantId: TenantId): TenantFicOauthStates {
  const inTenant = eq(ficOauthStates.tenantId, tenantId);

  return {
    async create(input) {
      const { userId, state, codeVerifierEnc, expiresAt, now } = parse(createFicOauthStateInputSchema, input);
      try {
        await db.transaction(async (tx) => {
          await tx.delete(ficOauthStates).where(and(inTenant, lte(ficOauthStates.expiresAt, now)));
          await tx.insert(ficOauthStates).values({
            tenantId,
            userId,
            stateHash: hashFicOauthState(state),
            codeVerifierEnc,
            expiresAt,
          });
        });
      } catch (error) {
        if (isForeignKeyViolation(error, STATE_USER_FK)) throw new UserNotInTenantError(userId);
        throw error;
      }
    },

    async consume(state, now) {
      if (typeof state !== "string" || state === "" || state.length > STATE_MAX_LENGTH) return null;
      const [row] = await db
        .update(ficOauthStates)
        .set({ usedAt: now })
        .where(and(inTenant, eq(ficOauthStates.stateHash, hashFicOauthState(state)), isNull(ficOauthStates.usedAt)))
        .returning({
          userId: ficOauthStates.userId,
          expiresAt: ficOauthStates.expiresAt,
          codeVerifierEnc: ficOauthStates.codeVerifierEnc,
        });
      return row ?? null;
    },
  };
}
