import { z } from "zod";

/**
 * Zod schemas of the Fatture in Cloud API v2 responses used by Vistato.
 *
 * Everything FiC answers is untrusted input. The objects are not `strict`: fields
 * Vistato does not use are ignored (and dropped from the output), so FiC can add fields
 * without breaking us. The fields Vistato uses are validated tightly: a positive integer
 * id, a non-blank name of bounded length.
 */

/** Anti-abuse cap on names coming from FiC. */
const FIC_NAME_MAX_LENGTH = 500;

/** A FiC id: positive safe integer (Zod 4 `int()` already rejects unsafe integers). */
export const ficIdSchema = z.number().int().positive();

const ficNameSchema = z
  .string()
  .max(FIC_NAME_MAX_LENGTH)
  .refine((value) => value.trim() !== "", { message: "must not be blank" });

/** One company in `GET /user/companies` (`data.companies[]`). */
const ficCompanySchema = z.object({
  id: ficIdSchema,
  name: ficNameSchema,
});

export interface FicCompany {
  id: number;
  name: string;
}

/** `GET /user/companies` → `{ data: { companies: [...] } }`. */
export const listCompaniesResponseSchema = z
  .object({
    data: z.object({
      companies: z.array(ficCompanySchema),
    }),
  })
  .transform(({ data }): FicCompany[] => data.companies.map(({ id, name }) => ({ id, name })));

export interface FicCompanyInfo {
  companyId: number;
  name: string;
}

/** `GET /c/{company_id}/company/info` → `{ data: { company_id, name, ... } }`. */
export const companyInfoResponseSchema = z
  .object({
    data: z.object({
      company_id: ficIdSchema,
      name: ficNameSchema,
    }),
  })
  .transform(({ data }): FicCompanyInfo => ({ companyId: data.company_id, name: data.name }));

/** Longest token accepted from FiC (anti-abuse; the secret box handles up to 8 KB). */
export const FIC_OAUTH_TOKEN_MAX_LENGTH = 4096;
/** Longest access token lifetime accepted (10 years): a larger value is not credible. */
const FIC_OAUTH_MAX_EXPIRES_IN_SECONDS = 10 * 365 * 24 * 60 * 60;

/** A token as it may travel in an `Authorization` header: visible ASCII only, bounded. */
const ficOauthTokenSchema = z
  .string()
  .min(1)
  .max(FIC_OAUTH_TOKEN_MAX_LENGTH)
  .regex(/^[\x21-\x7e]+$/, "must be visible ASCII");

export interface FicOAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Lifetime of the access token, in seconds from the response. */
  expiresInSeconds: number;
}

/**
 * `POST /oauth/token` (authorization code grant) →
 * `{ token_type: "bearer", access_token, refresh_token, expires_in }`.
 */
export const oauthTokenResponseSchema = z
  .object({
    token_type: z.string().refine((value) => value.toLowerCase() === "bearer", { message: "must be bearer" }),
    access_token: ficOauthTokenSchema,
    refresh_token: ficOauthTokenSchema,
    expires_in: z.number().int().positive().max(FIC_OAUTH_MAX_EXPIRES_IN_SECONDS),
  })
  .transform(
    (body): FicOAuthTokens => ({
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresInSeconds: body.expires_in,
    }),
  );

export interface FicOAuthRefreshedTokens {
  accessToken: string;
  /** The new refresh token when FiC rotates it; null when FiC keeps the old one valid. */
  refreshToken: string | null;
  expiresInSeconds: number;
}

/**
 * `POST /oauth/token` (refresh token grant): same as above, but `refresh_token` may be missing
 * (or null): FiC does not have to rotate it, and then the old one stays in use.
 */
export const oauthRefreshResponseSchema = z
  .object({
    token_type: z.string().refine((value) => value.toLowerCase() === "bearer", { message: "must be bearer" }),
    access_token: ficOauthTokenSchema,
    refresh_token: ficOauthTokenSchema.nullish(),
    expires_in: z.number().int().positive().max(FIC_OAUTH_MAX_EXPIRES_IN_SECONDS),
  })
  .transform(
    (body): FicOAuthRefreshedTokens => ({
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresInSeconds: body.expires_in,
    }),
  );
