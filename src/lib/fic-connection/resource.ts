import type { FicConnection, TenantScope } from "@/db/tenant-scope";
import type { FicIbanAlertAccess } from "@/lib/fic-iban-alert/access";
import { buildLinks, resource, type Link } from "@/lib/hateoas";

/** `GET /api/integrations/fic`, linked from `GET /api` for whoever may read it. */
export const FIC_INTEGRATION_LINK: Link = { href: "/api/integrations/fic", title: "Fatture in Cloud" };
export const FIC_CONNECT_LINK: Link = {
  href: "/api/integrations/fic/connect",
  method: "POST",
  title: "Collega Fatture in Cloud",
};
export const FIC_SELECT_COMPANY_LINK: Link = {
  href: "/api/integrations/fic/company",
  method: "POST",
  title: "Scegli l'azienda da collegare",
};

/** What the API calls the state of the link ("not_connected" = no connection row). */
export type FicIntegrationStatus = "not_connected" | FicConnection["status"];

export interface FicConnectedBy {
  id: string;
  firstName: string;
  lastName: string;
}

/**
 * The single source of the Fatture in Cloud integration resource and of its links. Built
 * from an explicit list of fields: no token, verifier or state can ever be in it. `connect`
 * and `select-company` follow `ficIbanAlertAccess(...).canManage` (the rule of the
 * endpoints) and the state the endpoints require.
 */
export function toFicIntegrationResource(
  connection: FicConnection | null,
  access: Pick<FicIbanAlertAccess, "canManage">,
  connectedBy: FicConnectedBy | null,
) {
  const status: FicIntegrationStatus = connection?.status ?? "not_connected";
  const connected = connection?.status === "connected";
  return resource(
    {
      status,
      companyId: connected ? connection.companyId : null,
      companyName: connected ? connection.companyName : null,
      connectedAt: connected && connection.connectedAt ? connection.connectedAt.toISOString() : null,
      connectedBy: connected ? connectedBy : null,
      companies:
        connection?.status === "pending_company_selection"
          ? (connection.availableCompanies ?? []).map(({ id, name }) => ({ id, name }))
          : null,
    },
    buildLinks([
      { rel: "self", link: FIC_INTEGRATION_LINK, allowed: true },
      { rel: "connect", link: FIC_CONNECT_LINK, allowed: access.canManage && status === "not_connected" },
      {
        rel: "select-company",
        link: FIC_SELECT_COMPANY_LINK,
        allowed: access.canManage && status === "pending_company_selection",
      },
    ]),
  );
}

/** Reads the tenant's connection and the user who made it, and builds the resource. */
export async function loadFicIntegrationResource(
  scope: Pick<TenantScope, "ficConnection" | "users">,
  access: Pick<FicIbanAlertAccess, "canManage">,
  connection?: FicConnection | null,
) {
  const current = connection === undefined ? await scope.ficConnection.get() : connection;
  let connectedBy: FicConnectedBy | null = null;
  if (current?.status === "connected") {
    const user = await scope.users.findById(current.connectedByUserId);
    if (user) connectedBy = { id: user.id, firstName: user.firstName, lastName: user.lastName };
  }
  return toFicIntegrationResource(current, access, connectedBy);
}
