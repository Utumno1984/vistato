import { requireSession } from "@/lib/auth/session";
import { userResource } from "@/lib/auth/user-resource";

/** The authenticated user and their tenant. */
export async function GET(request: Request) {
  const auth = await requireSession(request);
  if (auth instanceof Response) return auth;
  return Response.json(userResource(auth), { headers: { "Cache-Control": "no-store" } });
}
