import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { REQUEST_PATH_HEADER, safeNextPath } from "./next-path";
import { getSessionFromCookies, type AuthContext } from "./session";

/**
 * For protected Server Components (layout and pages): the session of the request or a
 * redirect to /login. Cached per request, so calling it in the layout and in the page costs
 * one query. Pages call it too because layouts are not re-rendered on client-side navigation.
 */
export const requirePageSession = cache(async (): Promise<AuthContext> => {
  const auth = await getSessionFromCookies();
  if (!auth) {
    // The proxy tells us the requested path; it is re-validated, never trusted.
    const asked = (await headers()).get(REQUEST_PATH_HEADER);
    redirect(asked ? `/login?next=${encodeURIComponent(safeNextPath(asked))}` : "/login");
  }
  return auth;
});
