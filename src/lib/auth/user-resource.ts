import type { ResolvedSession } from "@/db/auth";
import { buildLinks, resource } from "@/lib/hateoas";
import { UPLOAD_INVOICE_LINK } from "@/lib/invoices/resource";

/** The authenticated user as an API resource: no password hash, no token. */
export function userResource({ user, tenant }: Pick<ResolvedSession, "user" | "tenant">) {
  return resource(
    {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      tenant: { id: tenant.id, businessName: tenant.businessName },
    },
    buildLinks([
      { rel: "self", link: { href: "/api/me" }, allowed: true },
      { rel: "upload-invoice", link: UPLOAD_INVOICE_LINK, allowed: true },
      { rel: "logout", link: { href: "/api/auth/logout", method: "POST", title: "Esci" }, allowed: true },
    ]),
  );
}
