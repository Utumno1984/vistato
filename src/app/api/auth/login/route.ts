import { z } from "zod";

import { createSession, resolveSession, verifyCredentials } from "@/db/auth";
import { PASSWORD_MAX_LENGTH } from "@/lib/auth/password";
import { sessionCookie } from "@/lib/auth/session-cookie";
import { userResource } from "@/lib/auth/user-resource";
import { errorResponse, invalidRequest, zodIssues } from "@/lib/http/errors";
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

export async function POST(request: Request) {
  let payload: unknown;
  try {
    const text = await request.text();
    if (text.length > BODY_MAX_LENGTH) {
      return invalidRequest([{ field: "body", message: "Richiesta troppo grande" }]);
    }
    payload = JSON.parse(text);
  } catch {
    return invalidRequest([{ field: "body", message: "Il corpo deve essere JSON valido" }]);
  }

  const parsed = loginSchema.safeParse(payload);
  if (!parsed.success) return invalidRequest(zodIssues(parsed.error));

  const authenticated = await verifyCredentials(parsed.data.email, parsed.data.password);
  if (!authenticated) return invalidCredentials();

  const token = await createSession(authenticated.user.id, authenticated.tenantId);
  // Same resolution as GET /api/me: the response body is the same resource.
  const session = await resolveSession(token);
  if (!session) return invalidCredentials();

  return Response.json(userResource(session), {
    headers: { "Set-Cookie": sessionCookie(token), "Cache-Control": "no-store" },
  });
}
