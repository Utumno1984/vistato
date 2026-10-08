import { requirePageSession } from "@/lib/auth/page-session";
import { userResource } from "@/lib/auth/user-resource";
import { hasLink } from "@/lib/hateoas";

import { LogoutButton } from "./logout-button";

/** Protected area: every page below needs a valid session (checked on the server). */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const auth = await requirePageSession();
  const me = userResource(auth);
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
        {hasLink(me, "logout") ? <LogoutButton href={me._links.logout.href} label={me._links.logout.title ?? "Esci"} /> : null}
      </header>
      {children}
    </>
  );
}
