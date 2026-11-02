"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";

interface ActionLink {
  href: string;
  method?: string;
  title?: string;
}

const FALLBACK_MESSAGE = "Operazione non riuscita, riprova.";
const SETTINGS_PATH = "/impostazioni/fatture-in-cloud";

async function errorMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "message" in body && typeof body.message === "string") return body.message;
  } catch {
    // not JSON: use the fallback
  }
  return FALLBACK_MESSAGE;
}

/** A URL FiC sends the browser to: http(s) only, never `javascript:` and the like. */
function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * The actions of the page. Each button exists only if the server passed the matching link of
 * the resource, and a click calls that link (the endpoint checks permission and state again).
 * The component stays mounted when the page refreshes, so an error (e.g. 409 because another
 * tab already unlinked) stays visible while the page shows the new state.
 */
export function FicActions({
  connect,
  selectCompany,
  disconnect,
  companies,
}: {
  connect: ActionLink | null;
  selectCompany: ActionLink | null;
  disconnect: ActionLink | null;
  companies: Array<{ id: number; name: string }>;
}) {
  const router = useRouter();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * One call at a time (a double click does nothing). `onOk` gets the response of a 2xx and
   * returns true when it sends the browser away (the buttons then stay disabled).
   */
  async function call(link: ActionLink, body: unknown, onOk: (res: Response) => Promise<boolean>) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    let leaving = false;
    try {
      const res = await fetch(link.href, {
        method: link.method ?? "GET",
        ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      });
      if (res.status === 401) {
        leaving = true;
        window.location.assign(`/login?next=${encodeURIComponent(SETTINGS_PATH)}`);
        return;
      }
      if (res.ok) leaving = await onOk(res);
      else {
        setConfirming(false);
        setError(await errorMessage(res));
      }
      // Success or conflict alike: show the current state.
      if (!leaving) router.refresh();
    } catch {
      setError(FALLBACK_MESSAGE);
    } finally {
      if (!leaving) {
        busy.current = false;
        setPending(false);
      }
    }
  }

  function startConnect(link: ActionLink) {
    void call(link, undefined, async (res) => {
      const { authorizationUrl } = (await res.json()) as { authorizationUrl?: unknown };
      if (!isHttpUrl(authorizationUrl)) throw new Error("bad authorization URL");
      window.location.assign(authorizationUrl);
      return true;
    });
  }

  return (
    <div className="mt-6">
      {selectCompany && companies.length > 0 ? (
        <ul aria-label="Aziende disponibili" className="flex flex-col gap-3">
          {companies.map((company) => (
            <li
              key={company.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
            >
              <span className="min-w-0 break-words">
                <span className="font-medium">{company.name}</span>
                <span className="text-sm text-zinc-600 dark:text-zinc-400">{` (ID ${company.id})`}</span>
              </span>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => void call(selectCompany, { companyId: company.id }, async () => false)}
              >
                Collega questa azienda
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-3">
        {connect ? (
          <Button type="button" disabled={pending} onClick={() => startConnect(connect)}>
            Collega Fatture in Cloud
          </Button>
        ) : null}
        {disconnect && !confirming ? (
          <Button type="button" variant="outline" disabled={pending} onClick={() => setConfirming(true)}>
            Scollega
          </Button>
        ) : null}
      </div>
      {disconnect && confirming ? (
        <div role="group" aria-label="Conferma scollegamento" className="mt-3 flex flex-col gap-3">
          <p className="text-sm">
            Vuoi scollegare Fatture in Cloud? Vistato non leggerà più le fatture finché non ricolleghi l&apos;account.
          </p>
          <div className="flex gap-3">
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() =>
                void call(disconnect, undefined, async () => {
                  setConfirming(false);
                  return false;
                })
              }
            >
              Conferma scollegamento
            </Button>
            <Button type="button" variant="outline" disabled={pending} onClick={() => setConfirming(false)}>
              Annulla
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
