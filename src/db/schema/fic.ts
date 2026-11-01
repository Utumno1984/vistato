import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { baseColumns } from "./columns";
import { ficConnectionStatus } from "./enums";
import { tenants } from "./tenants";
import { users } from "./users";

/**
 * One OAuth2 authorization request towards Fatture in Cloud (Authorization Code + PKCE), bound
 * to the user who started it and to their tenant (composite foreign key). Only the SHA-256 of
 * the `state` is stored; the PKCE `code_verifier` is encrypted (purpose `fic_pkce_verifier`,
 * AAD = tenant). Single use: `used_at` is set by the first callback, whatever its outcome.
 */
export const ficOauthStates = pgTable(
  "fic_oauth_states",
  {
    ...baseColumns(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    userId: uuid("user_id").notNull(),
    stateHash: text("state_hash").notNull(),
    codeVerifierEnc: text("code_verifier_enc").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (table) => [
    // Like sessions: a deleted user takes its pending authorization requests with it.
    foreignKey({
      name: "fic_oauth_states_user_id_tenant_id_users_fk",
      columns: [table.userId, table.tenantId],
      foreignColumns: [users.id, users.tenantId],
    }).onDelete("cascade"),
    unique("fic_oauth_states_state_hash_unique").on(table.stateHash),
    // Cleanup of the expired states of a tenant at every new authorization request.
    index("fic_oauth_states_tenant_id_expires_at_index").on(table.tenantId, table.expiresAt),
    // The cascade from users.
    index("fic_oauth_states_user_id_index").on(table.userId),
    check("fic_oauth_states_state_hash_format", sql`${table.stateHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * Why a link went to `reauthorization_required` (`last_refresh_error`):
 * - `refresh_rejected`: FiC refused the refresh token (`invalid_grant`, 400/401);
 * - `save_failed`: FiC renewed the tokens but saving them failed (the old refresh token may
 *   already be invalid, so the link cannot be trusted any more).
 */
export const FIC_REFRESH_ERRORS = ["refresh_rejected", "save_failed"] as const;

/**
 * The link of a tenant to its Fatture in Cloud company: at most one per tenant, and a FiC
 * company is linked to at most one tenant (unique `fic_company_id`; NULL, allowed many times,
 * while the user has still to choose among several companies). Tokens are encrypted with the
 * tenant as AAD (purposes `fic_access_token` / `fic_refresh_token`); they are NULL, together
 * with their expiry, exactly in `reauthorization_required`. Unlinking deletes the row: no
 * history with or without secrets is kept, so the company is free for another tenant at once.
 */
export const ficConnections = pgTable(
  "fic_connections",
  {
    ...baseColumns(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    status: ficConnectionStatus("status").notNull(),
    ficCompanyId: bigint("fic_company_id", { mode: "number" }),
    companyName: text("company_name"),
    /** `[{ id, name }]` of the FiC user's companies, only while waiting for the choice (validated with Zod). */
    availableCompanies: jsonb("available_companies"),
    /** NULL only in `reauthorization_required` (check `fic_connections_tokens_by_status`). */
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    /** The OAuth scopes granted, space-separated (as sent to FiC). */
    scopes: text("scopes").notNull(),
    /** The user whose FiC authorization produced the tokens. */
    connectedByUserId: uuid("connected_by_user_id").notNull(),
    /** When the link became `connected` (NULL while waiting for the choice of the company). */
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    /** When and why the tokens were dropped (set together with `reauthorization_required`). */
    lastRefreshErrorAt: timestamp("last_refresh_error_at", { withTimezone: true }),
    lastRefreshError: text("last_refresh_error", { enum: FIC_REFRESH_ERRORS }),
  },
  (table) => [
    unique("fic_connections_tenant_id_unique").on(table.tenantId),
    // The database, not an application check, refuses to link a company to a second tenant.
    unique("fic_connections_fic_company_id_unique").on(table.ficCompanyId),
    foreignKey({
      name: "fic_connections_connected_by_user_id_tenant_id_users_fk",
      columns: [table.connectedByUserId, table.tenantId],
      foreignColumns: [users.id, users.tenantId],
    }).onDelete("restrict"),
    check("fic_connections_fic_company_id_positive", sql`${table.ficCompanyId} IS NULL OR ${table.ficCompanyId} > 0`),
    check(
      "fic_connections_connected_has_company",
      sql`${table.status} <> 'connected' OR (${table.ficCompanyId} IS NOT NULL AND ${table.companyName} IS NOT NULL AND ${table.connectedAt} IS NOT NULL AND ${table.availableCompanies} IS NULL)`,
    ),
    check(
      "fic_connections_pending_has_choices",
      sql`${table.status} <> 'pending_company_selection' OR (${table.ficCompanyId} IS NULL AND ${table.companyName} IS NULL AND ${table.connectedAt} IS NULL AND jsonb_typeof(${table.availableCompanies}) = 'array')`,
    ),
    // `::text`: a new enum value cannot be used in the transaction that adds it (the migrations run in one).
    check(
      "fic_connections_tokens_by_status",
      sql`CASE WHEN ${table.status}::text = 'reauthorization_required'
        THEN ${table.accessTokenEnc} IS NULL AND ${table.refreshTokenEnc} IS NULL AND ${table.accessTokenExpiresAt} IS NULL
          AND ${table.ficCompanyId} IS NOT NULL AND ${table.companyName} IS NOT NULL AND ${table.availableCompanies} IS NULL
          AND ${table.lastRefreshErrorAt} IS NOT NULL AND ${table.lastRefreshError} IS NOT NULL
        ELSE ${table.accessTokenEnc} IS NOT NULL AND ${table.refreshTokenEnc} IS NOT NULL AND ${table.accessTokenExpiresAt} IS NOT NULL
        END`,
    ),
    check(
      "fic_connections_last_refresh_error_valid",
      sql`(${table.lastRefreshError} IS NULL) = (${table.lastRefreshErrorAt} IS NULL) AND (${table.lastRefreshError} IS NULL OR ${table.lastRefreshError} IN ('refresh_rejected', 'save_failed'))`,
    ),
  ],
);

export type FicOauthState = typeof ficOauthStates.$inferSelect;
export type FicConnectionRow = typeof ficConnections.$inferSelect;
