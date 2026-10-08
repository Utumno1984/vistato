import type { ZodError } from "zod";

/**
 * Uniform JSON error body of every API: `{ error, message, issues? }`.
 * `error` is a stable machine-readable code (English), `message` is for people (Italian).
 */
export interface ApiErrorBody {
  error: string;
  message: string;
  issues?: ApiIssue[];
}

export interface ApiIssue {
  field: string;
  message: string;
}

export function errorResponse(
  status: number,
  error: string,
  message: string,
  options: { issues?: ApiIssue[]; headers?: HeadersInit } = {},
): Response {
  const body: ApiErrorBody = { error, message, ...(options.issues ? { issues: options.issues } : {}) };
  const headers = new Headers(options.headers);
  // Error responses must never be stored by browsers or proxies.
  headers.set("Cache-Control", "no-store");
  return Response.json(body, { status, headers });
}

/** The Zod issues as `{ field, message }`, `field` being the dotted path ("body" for the root). */
export function zodIssues(error: ZodError): ApiIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.map(String).join(".") : "body",
    message: issue.message,
  }));
}

export function invalidRequest(issues: ApiIssue[]): Response {
  return errorResponse(400, "invalid_request", "Richiesta non valida", { issues });
}

export function unauthenticated(): Response {
  return errorResponse(401, "unauthenticated", "Autenticazione richiesta");
}

export function forbiddenOrigin(): Response {
  return errorResponse(403, "forbidden_origin", "Origine della richiesta non consentita");
}
