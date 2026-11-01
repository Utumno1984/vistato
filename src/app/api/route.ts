import { getRequestSession } from "@/lib/auth/session";
import { forTenant } from "@/db/tenant-scope";
import { FIC_INTEGRATION_LINK } from "@/lib/fic-connection/resource";
import { ficIbanAlertAccess } from "@/lib/fic-iban-alert/access";
import { buildLinks, resource } from "@/lib/hateoas";
import { INVOICES_COLLECTION_LINK, UPLOAD_INVOICE_LINK } from "@/lib/invoices/resource";

/** API entry point: clients discover everything else from these links. */
export async function GET(request: Request) {
  const session = await getRequestSession(request);
  const authenticated = session !== null;
  // Same rule as the endpoints of the add-on (`requireFicIbanAlert(..., "read")`).
  const canReadFic = session
    ? (await ficIbanAlertAccess({ user: session.user, scope: forTenant(session.tenant.id) })).canRead
    : false;
  return Response.json(
    resource(
      { name: "vistato", version: process.env.npm_package_version ?? "0.1.0" },
      buildLinks([
        { rel: "self", link: { href: "/api" }, allowed: true },
        { rel: "health", link: { href: "/api/health", title: "Service health" }, allowed: true },
        { rel: "login", link: { href: "/api/auth/login", method: "POST", title: "Accedi" }, allowed: !authenticated },
        { rel: "me", link: { href: "/api/me", title: "Utente corrente" }, allowed: authenticated },
        { rel: "invoices", link: INVOICES_COLLECTION_LINK, allowed: authenticated },
        { rel: "upload-invoice", link: UPLOAD_INVOICE_LINK, allowed: authenticated },
        { rel: "fic-integration", link: FIC_INTEGRATION_LINK, allowed: canReadFic },
        { rel: "logout", link: { href: "/api/auth/logout", method: "POST", title: "Esci" }, allowed: authenticated },
      ]),
    ),
    { headers: { "Cache-Control": "no-store" } },
  );
}
