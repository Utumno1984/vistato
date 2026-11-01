import { postFicConnect } from "@/lib/fic-connection/http";

/** Starts the OAuth2 authorization on Fatture in Cloud (OWNER or ADMIN): 200 `{ authorizationUrl }`. */
export async function POST(request: Request) {
  return postFicConnect(request);
}
