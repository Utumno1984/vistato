import { cache } from "react";
import { redirect } from "next/navigation";

import { getSessionFromCookies, type AuthContext } from "./session";

/**
 * For protected Server Components (layout and pages): the session of the request or a
 * redirect to /login. Cached per request, so calling it in the layout and in the page costs
 * one query. Pages call it too because layouts are not re-rendered on client-side navigation.
 */
export const requirePageSession = cache(async (): Promise<AuthContext> => {
  const auth = await getSessionFromCookies();
  if (!auth) redirect("/login");
  return auth;
});
