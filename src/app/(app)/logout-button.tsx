"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";

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
      <Button type="button" variant="outline" onClick={logout}>
        {label}
      </Button>
    </div>
  );
}
