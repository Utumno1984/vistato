import { getFicCallback } from "@/lib/fic-connection/http";

/** Return from Fatture in Cloud after the authorization: 303 to the settings page with `?esito=`. */
export async function GET(request: Request) {
  return getFicCallback(request);
}
