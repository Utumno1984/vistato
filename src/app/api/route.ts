import { getRequestSession } from "@/lib/auth/session";
import { buildLinks, resource } from "@/lib/hateoas";

/** API entry point: clients discover everything else from these links. */
export async function GET(request: Request) {
  const authenticated = (await getRequestSession(request)) !== null;
  return Response.json(
    resource(
      { name: "vistato", version: process.env.npm_package_version ?? "0.1.0" },
      buildLinks([
        { rel: "self", link: { href: "/api" }, allowed: true },
        { rel: "health", link: { href: "/api/health", title: "Service health" }, allowed: true },
        { rel: "login", link: { href: "/api/auth/login", method: "POST", title: "Accedi" }, allowed: !authenticated },
        { rel: "me", link: { href: "/api/me", title: "Utente corrente" }, allowed: authenticated },
        { rel: "logout", link: { href: "/api/auth/logout", method: "POST", title: "Esci" }, allowed: authenticated },
      ]),
    ),
    { headers: { "Cache-Control": "no-store" } },
  );
}
