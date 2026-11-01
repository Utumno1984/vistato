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
