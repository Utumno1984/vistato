"use server";

import { getSessionFromCookies } from "@/lib/auth/session";
import { uploadInvoiceFile } from "@/lib/invoices/upload";
import { describeUploadResponse, type UploadOutcome } from "@/lib/invoices/upload-messages";

/**
 * Server Action of the upload form: same service as `POST /api/invoices`, same session.
 * Always answers normally (never a failing HTTP status), so the browser logs nothing on a
 * refused file. The tenant comes from the session, never from the form.
 */
export async function uploadInvoiceAction(formData: FormData): Promise<UploadOutcome> {
  const auth = await getSessionFromCookies();
  if (!auth) return { kind: "unauthenticated" };

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return describeUploadResponse(400, { error: "invalid_request", issues: [{ field: "file", message: "obbligatorio" }] });
  }
  const response = await uploadInvoiceFile(auth, file);
  const body: unknown = await response.json().catch(() => null);
  return describeUploadResponse(response.status, body);
}
