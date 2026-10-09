import { DuplicateInvoiceError, ValidationError } from "@/db/errors";
import { requireSession } from "@/lib/auth/session";
import { MAX_FATTURAPA_BYTES, parseFatturaPA } from "@/lib/fatturapa/parse";
import { errorResponse, invalidRequest } from "@/lib/http/errors";
import { toInvoiceResource } from "@/lib/invoices/resource";

/** Largest accepted file (5 MB). The parser enforces the same limit on the bytes it receives. */
const MAX_UPLOAD_BYTES = MAX_FATTURAPA_BYTES;

/** Room for the multipart framing (boundaries, headers, other small fields) around the file. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_BODY_BYTES = MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES;

const tooLarge = () => errorResponse(413, "payload_too_large", "Il file supera la dimensione massima di 5 MB");

/** Reads the body, stopping as soon as it exceeds the limit. Null: too large. */
async function readLimitedBody(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * Uploads a FatturaPA XML (multipart, field `file`) as a PENDING invoice of the caller's tenant.
 * Any other field of the form (`tenantId`, `status`, ...) is ignored.
 */
export async function POST(request: Request) {
  const auth = await requireSession(request);
  if (auth instanceof Response) return auth;

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";")[0].trim().toLowerCase() !== "multipart/form-data") {
    return invalidRequest([{ field: "file", message: "La richiesta deve essere multipart/form-data con il campo file" }]);
  }

  const body = await readLimitedBody(request);
  if (body === null) return tooLarge();

  let form: FormData;
  try {
    form = await new Response(body as BodyInit, { headers: { "content-type": contentType } }).formData();
  } catch {
    return invalidRequest([{ field: "body", message: "Il corpo della richiesta non è un multipart valido" }]);
  }

  const files = form.getAll("file");
  if (files.length === 0) return invalidRequest([{ field: "file", message: "Il campo file è obbligatorio" }]);
  if (files.length > 1) return invalidRequest([{ field: "file", message: "Carica un solo file per richiesta" }]);
  const file = files[0];
  if (typeof file === "string") return invalidRequest([{ field: "file", message: "Il campo file deve essere un file" }]);
  if (file.size === 0) return invalidRequest([{ field: "file", message: "Il file è vuoto" }]);
  if (file.size > MAX_UPLOAD_BYTES) return tooLarge();
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
