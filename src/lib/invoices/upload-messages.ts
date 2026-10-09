/**
 * Maps the answer of `POST /api/invoices` to what the upload form shows: the single place
 * where API error codes become Italian messages.
 */
export const UPLOAD_SUCCESS_MESSAGE = "Fattura caricata";
export const UPLOAD_NO_FILE_MESSAGE = "Seleziona un file XML";
export const UPLOAD_FALLBACK_MESSAGE = "Caricamento non riuscito, riprova";

export type UploadOutcome =
  | { kind: "success"; messages: string[] }
  | { kind: "error"; messages: string[] }
  | { kind: "unauthenticated" };

interface ApiBody {
  error?: unknown;
  issues?: unknown;
}

function issueMessages(body: ApiBody): string[] {
  if (!Array.isArray(body.issues)) return [];
  return body.issues.flatMap((issue: unknown) => {
    const message = (issue as { message?: unknown } | null)?.message;
    return typeof message === "string" && message ? [message] : [];
  });
}

/** `body` is the parsed JSON of the response, or null when it was not JSON. */
export function describeUploadResponse(
  status: number,
  body: unknown,
): UploadOutcome {
  if (status === 201)
    return { kind: "success", messages: [UPLOAD_SUCCESS_MESSAGE] };
  if (status === 401) return { kind: "unauthenticated" };
  const parsed: ApiBody =
    body && typeof body === "object" ? (body as ApiBody) : {};
  const error = (message: string): UploadOutcome => ({
    kind: "error",
    messages: [message],
  });
  switch (parsed.error) {
    case "duplicate_invoice":
      return error("Questa fattura è già stata caricata");
    case "payload_too_large":
      return error("Il file supera la dimensione massima di 5 MB");
    case "unsupported_media_type":
      return error(
        "Sono accettati solo file XML (.xml): i file firmati (.p7m) e gli altri formati non sono supportati",
      );
    case "invalid_invoice": {
      const messages = issueMessages(parsed);
      return {
        kind: "error",
        messages:
          messages.length > 0
            ? messages
            : ["Il file non è una fattura elettronica valida"],
      };
    }
    case "invalid_request": {
      const messages = issueMessages(parsed);
      if (messages.some((message) => message.includes("vuoto")))
        return error("Il file è vuoto");
      return error(UPLOAD_NO_FILE_MESSAGE);
    }
    default:
      return error(UPLOAD_FALLBACK_MESSAGE);
  }
}
