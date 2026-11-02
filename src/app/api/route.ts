import { apiEntryResource } from "@/lib/api-entry";
import { getRequestSession } from "@/lib/auth/session";

/** API entry point: clients discover everything else from these links. */
export async function GET(request: Request) {
  return Response.json(await apiEntryResource(await getRequestSession(request)), {
    headers: { "Cache-Control": "no-store" },
  });
}
