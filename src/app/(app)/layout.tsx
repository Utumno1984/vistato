import Link from "next/link";

import { apiEntryResource } from "@/lib/api-entry";
import { FIC_SETTINGS_PATH } from "@/lib/fic-connection/outcomes";
import { requirePageSession } from "@/lib/auth/page-session";
import { userResource } from "@/lib/auth/user-resource";
import { hasLink } from "@/lib/hateoas";

import { LogoutButton } from "./logout-button";

/** Protected area: every page below needs a valid session (checked on the server). */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const auth = await requirePageSession();
  const me = userResource(auth);
  // The menu follows the links of GET /api: an entry is there only if the entry point links to it.
  const entry = await apiEntryResource(auth);
  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-200 px-6 py-3 dark:border-zinc-800">
        <div>
          <p className="text-lg font-semibold">Vistato</p>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            <span data-testid="user-name">{`${me.firstName} ${me.lastName}`}</span>
            {" · "}
            <span data-testid="tenant-name">{me.tenant.businessName}</span>
          </p>
        </div>
        <nav aria-label="Navigazione principale" className="flex items-center gap-4 text-sm">
          <Link href="/fatture" className="underline-offset-4 hover:underline">
            Fatture
          </Link>
          {hasLink(entry, "fic-integration") ? (
            <Link href={FIC_SETTINGS_PATH} className="underline-offset-4 hover:underline">
              Impostazioni
            </Link>
          ) : null}
        </nav>
        {hasLink(me, "logout") ? <LogoutButton href={me._links.logout.href} label={me._links.logout.title ?? "Esci"} /> : null}
      </header>
      {children}
    </>
  );
}
