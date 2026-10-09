import { requireSession } from "@/lib/auth/session";
import { invalidRequest } from "@/lib/http/errors";
import { parseInvoiceListQuery, toInvoiceCollection } from "@/lib/invoices/collection";
import { MAX_UPLOAD_BYTES, tooLargeResponse, uploadInvoiceFile } from "@/lib/invoices/upload";

/** Room for the multipart framing (boundaries, headers, other small fields) around the file. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_BODY_BYTES = MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES;

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
 * The caller's tenant invoices, newest upload first, as a paginated HAL collection.
 * Query: `status` (PENDING, APPROVED, REJECTED; empty means all), `page` (from 1), `pageSize` (1-100, default 20).
 */
export async function GET(request: Request) {
  const auth = await requireSession(request);
  if (auth instanceof Response) return auth;

  const parsed = parseInvoiceListQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return invalidRequest(parsed.issues);

  const result = await auth.scope.invoices.list(parsed.query);
  return Response.json(toInvoiceCollection(result, parsed.query, { userId: auth.user.id, role: auth.user.role }), {
    headers: { "Cache-Control": "no-store" },
  });
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
  if (body === null) return tooLargeResponse();

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
  return uploadInvoiceFile(auth, file);
}
