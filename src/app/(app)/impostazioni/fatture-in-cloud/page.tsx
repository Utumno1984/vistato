import type { Metadata } from "next";

import { requirePageSession } from "@/lib/auth/page-session";
import { loadFicIntegrationResource } from "@/lib/fic-connection/resource";
import { esitoNotice, MODULE_NOT_ACTIVE_MESSAGE, STATUS_HEADLINES } from "@/lib/fic-connection/settings-view";
import { ficIbanAlertAccess } from "@/lib/fic-iban-alert/access";
import { formatDateTime } from "@/lib/format/date";
import { hasLink } from "@/lib/hateoas";
import { Badge } from "@/components/ui/badge";

import { FicActions } from "./fic-actions";

export const metadata: Metadata = { title: "Fatture in Cloud · Impostazioni · Vistato" };

/**
 * State of the tenant's Fatture in Cloud link. The resource is built by the function of
 * `GET /api/integrations/fic` for the session's tenant (no ID in the URL) and the actions
 * shown are exactly its `_links`: the page has no authorization rule of its own.
 */
export default async function FicSettingsPage({ searchParams }: PageProps<"/impostazioni/fatture-in-cloud">) {
  const auth = await requirePageSession();
  const notice = esitoNotice((await searchParams).esito);
  const access = await ficIbanAlertAccess(auth);
  // The same call as the API: the tenant is the session's, the access rule is the endpoint's.
  const integration = access.moduleActive ? await loadFicIntegrationResource(auth.scope, access) : null;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
      <h1 className="text-3xl font-semibold tracking-tight">Fatture in Cloud</h1>
      {notice ? (
        <p
          role={notice.role}
          data-testid="esito"
          className={
            notice.role === "alert"
              ? "mt-4 rounded-lg border border-red-700 px-3 py-2 text-sm text-red-700 dark:border-red-400 dark:text-red-400"
              : "mt-4 rounded-lg border border-green-700 px-3 py-2 text-sm text-green-800 dark:border-green-400 dark:text-green-300"
          }
        >
          {notice.message}
        </p>
      ) : null}
      {integration === null ? (
        <p className="mt-6">{MODULE_NOT_ACTIVE_MESSAGE}</p>
      ) : (
        <section aria-label="Stato del collegamento" className="mt-6">
          <p className="flex flex-wrap items-center gap-3">
            <Badge variant={integration.status === "connected" ? "success" : "secondary"}>
              {integration.status === "connected" ? "Collegato" : "Non attivo"}
            </Badge>
            <span className="font-medium" data-testid="fic-headline">
              {STATUS_HEADLINES[integration.status]}
            </span>
          </p>
          {integration.companyId !== null ? (
            <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="font-medium">Azienda</dt>
              <dd className="break-words" data-testid="fic-company-name">
                {integration.companyName}
              </dd>
              <dt className="font-medium">ID azienda</dt>
              <dd data-testid="fic-company-id">{integration.companyId}</dd>
              {integration.connectedAt ? (
                <>
                  <dt className="font-medium">Collegata il</dt>
                  <dd data-testid="fic-connected-at">{formatDateTime(integration.connectedAt)}</dd>
                </>
              ) : null}
              {integration.connectedBy ? (
                <>
                  <dt className="font-medium">Collegata da</dt>
                  <dd className="break-words" data-testid="fic-connected-by">
                    {`${integration.connectedBy.firstName} ${integration.connectedBy.lastName}`}
                  </dd>
                </>
              ) : null}
            </dl>
          ) : null}
          <FicActions
            connect={hasLink(integration, "connect") ? integration._links.connect : null}
            selectCompany={hasLink(integration, "select-company") ? integration._links["select-company"] : null}
            disconnect={hasLink(integration, "disconnect") ? integration._links.disconnect : null}
            companies={integration.companies ?? []}
          />
        </section>
      )}
    </main>
  );
}
