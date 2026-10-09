import { DuplicateInvoiceError, ValidationError } from "@/db/errors";
import type { AuthContext } from "@/lib/auth/session";
import { parseFatturaPA } from "@/lib/fatturapa/parse";
import { errorResponse, invalidRequest } from "@/lib/http/errors";

import { toInvoiceResource } from "./resource";

import { MAX_UPLOAD_BYTES } from "./upload-messages";

/** Largest accepted file (5 MB, one constant shared with the form; the parser enforces the same limit). */
export { MAX_UPLOAD_BYTES };

export const tooLargeResponse = () =>
  errorResponse(413, "payload_too_large", "Il file supera la dimensione massima di 5 MB");

/**
 * Creates a PENDING invoice of the caller's tenant from an uploaded file. Shared by
 * `POST /api/invoices` and the upload form of /fatture, so both apply the same checks
 * (empty, size, extension, parser, duplicates). Answers with the API's `Response`.
 */
export async function uploadInvoiceFile(auth: AuthContext, file: File): Promise<Response> {
  if (file.size === 0) return invalidRequest([{ field: "file", message: "Il file è vuoto" }]);
  if (file.size > MAX_UPLOAD_BYTES) return tooLargeResponse();
  if (!file.name.toLowerCase().endsWith(".xml")) {
    return errorResponse(
      415,
      "unsupported_media_type",
      "Sono accettati solo file XML (.xml): i file firmati (.p7m) e gli altri formati non sono supportati",
    );
  }

  // Bytes, not a string: the parser checks size, signature and encoding itself.
  const parsed = parseFatturaPA(new Uint8Array(await file.arrayBuffer()), { normalizeVatCase: true });
  if (!parsed.ok) {
    return errorResponse(422, "invalid_invoice", "Il file non è una fattura elettronica valida", {
      issues: parsed.issues,
    });
  }

  const caller = { userId: auth.user.id, role: auth.user.role };
  try {
    const invoice = await auth.scope.invoices.create(parsed.data, auth.user.id);
    return Response.json(toInvoiceResource(invoice, caller), {
      status: 201,
      headers: { Location: `/api/invoices/${invoice.id}`, "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof DuplicateInvoiceError) {
      const existing = await auth.scope.invoices.findByBusinessKey(parsed.data);
      return Response.json(
        {
          error: "duplicate_invoice",
          message: "Questa fattura è già stata caricata (stesso fornitore, numero e data)",
          ...(existing ? { _links: toInvoiceResource(existing, caller)._links } : {}),
        },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (error instanceof ValidationError) {
      return errorResponse(422, "invalid_invoice", "Il file non è una fattura elettronica valida", {
        issues: error.issues.map(({ field, message }) => ({ field, message })),
      });
    }
    throw error;
  }
}
