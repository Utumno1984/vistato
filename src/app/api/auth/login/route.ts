import { z } from "zod";

import { createSession, deleteSession, resolveSession, verifyCredentials } from "@/db/auth";
import { PASSWORD_MAX_LENGTH } from "@/lib/auth/password";
import { hasForeignOrigin } from "@/lib/auth/session";
import { readSessionToken, sessionCookie } from "@/lib/auth/session-cookie";
import { userResource } from "@/lib/auth/user-resource";
import { errorResponse, forbiddenOrigin, invalidRequest, zodIssues } from "@/lib/http/errors";
import { emailSchema } from "@/lib/validation/email";

/** A login body is tiny: anything larger is rejected before parsing. */
const BODY_MAX_LENGTH = 8 * 1024;

const loginSchema = z.object({
  email: z.string({ error: "L'email è obbligatoria" }).pipe(emailSchema),
  password: z
    .string({ error: "La password è obbligatoria" })
    .min(1, "La password è obbligatoria")
    .max(PASSWORD_MAX_LENGTH, `La password non può superare ${PASSWORD_MAX_LENGTH} caratteri`),
});

const invalidCredentials = () => errorResponse(401, "invalid_credentials", "Email o password non validi");

/** Reads the body as text, stopping as soon as it exceeds the limit. Null: too large. */
async function readLimitedBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > BODY_MAX_LENGTH) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BODY_MAX_LENGTH) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(request: Request) {
  // Login CSRF: checked whether or not there is a session; a missing Origin (non-browser client) is allowed.
  if (hasForeignOrigin(request)) return forbiddenOrigin();

  const mediaType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    return errorResponse(415, "unsupported_media_type", "Il Content-Type deve essere application/json");
  }

  let payload: unknown;
  try {
    const text = await readLimitedBody(request);
    if (text === null) return invalidRequest([{ field: "body", message: "Richiesta troppo grande" }]);
    payload = JSON.parse(text);
  } catch {
    return invalidRequest([{ field: "body", message: "Il corpo deve essere JSON valido" }]);
  }

  const parsed = loginSchema.safeParse(payload);
  if (!parsed.success) return invalidRequest(zodIssues(parsed.error));

  const authenticated = await verifyCredentials(parsed.data.email, parsed.data.password);
  if (!authenticated) return invalidCredentials();

  // Re-login: the session of the previous cookie, if any, is ended instead of left orphaned.
  const previous = readSessionToken(request);
  if (previous) await deleteSession(previous);

  const token = await createSession(authenticated.user.id, authenticated.tenantId);
  // Same resolution as GET /api/me: the response body is the same resource.
  const session = await resolveSession(token);
  if (!session) return invalidCredentials();

  return Response.json(userResource(session), {
    headers: { "Set-Cookie": sessionCookie(token), "Cache-Control": "no-store" },
  });
}
