import { createHash } from "node:crypto";

import { and, eq, isNull, lte } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "@/db/client";
import { isForeignKeyViolation, isUniqueViolation, UserNotInTenantError, ValidationError } from "@/db/errors";
import { ficConnections, ficOauthStates, type FicConnectionRow } from "@/db/schema";

import type { TenantId } from "./tenant-id";

/*
 * Fatture in Cloud link of one tenant: the OAuth authorization requests (`fic_oauth_states`)
 * and the connection itself (`fic_connections`). Every statement filters on (or sets)
 * `tenant_id`.
 *
 * Secrets arrive here already encrypted (`*Enc`, see `src/lib/fic-connection/store.ts`, which
 * encrypts with this scope's tenant as AAD): the data layer cannot import the `server-only`
 * secret box, since scripts and e2e helpers load it outside Next. The encrypted tokens are
 * written here and never returned to application code.
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
  accessTokenExpiresAt: Date;
  connectedByUserId: string;
  connectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

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

export type CreateFicConnectionResult =
  | { outcome: "created"; connection: FicConnection }
  /** The tenant already has a connection (any status): nothing changed. */
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
   * (concurrent callbacks or tenants: one wins, the others save nothing).
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
        const [row] = await db
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
