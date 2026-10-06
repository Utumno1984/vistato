import { buildLinks, resource } from "@/lib/hateoas";

/** API entry point: clients discover everything else from these links. */
export async function GET() {
  return Response.json(
    resource(
      { name: "vistato", version: process.env.npm_package_version ?? "0.1.0" },
      buildLinks([
        { rel: "self", link: { href: "/api" }, allowed: true },
        { rel: "health", link: { href: "/api/health", title: "Service health" }, allowed: true },
      ]),
    ),
  );
}
