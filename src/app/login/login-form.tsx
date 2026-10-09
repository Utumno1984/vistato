"use client";

import { useRef, useState, useSyncExternalStore, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const subscribeNothing = () => () => {};
const UNAVAILABLE = "Servizio non disponibile, riprova tra poco.";

/** Signs in through POST /api/auth/login (same endpoint, same cookie as any API client). */
export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  // The button stays disabled until hydration: a submit before it would be a native form post.
  const ready = useSyncExternalStore(subscribeNothing, () => true, () => false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return; // double click
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        // Full navigation: the destination is rendered on the server with the new cookie.
        window.location.assign(next);
        return;
      }
      const body: { message?: string } | null = await res.json().catch(() => null);
      setError(res.status === 401 || res.status === 400 ? (body?.message ?? "Email o password non validi") : UNAVAILABLE);
    } catch {
      setError(UNAVAILABLE);
    }
    setPassword("");
    setPending(false);
    busy.current = false;
  }

  const field = "h-10 px-3 py-2";
  return (
    <form method="post" onSubmit={submit} className="flex flex-col gap-4" aria-busy={pending}>
      {error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col gap-1">
        <Label htmlFor="login-email">Email</Label>
        <Input
          id="login-email"
          name="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className={field}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="login-password">Password</Label>
        <Input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={field}
        />
      </div>
      <Button type="submit" disabled={!ready || pending}>
        Accedi
      </Button>
    </form>
  );
}
