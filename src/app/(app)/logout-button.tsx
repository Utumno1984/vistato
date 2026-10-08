"use client";

import { useRef, useState } from "react";

/** Ends the session through the `logout` link of /api/me, then goes to the login page. */
export function LogoutButton({ href, label }: { href: string; label: string }) {
  const busy = useRef(false);
  const [failed, setFailed] = useState(false);

  async function logout() {
    if (busy.current) return;
    busy.current = true;
    setFailed(false);
    try {
      const res = await fetch(href, { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      window.location.assign("/login");
    } catch {
      busy.current = false;
      setFailed(true);
    }
  }

  return (
    <div className="flex items-center gap-3">
      {failed ? (
        <span role="alert" className="text-sm text-red-700">
          Uscita non riuscita, riprova.
        </span>
      ) : null}
      <button
        type="button"
        onClick={logout}
        className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        {label}
      </button>
    </div>
  );
}
