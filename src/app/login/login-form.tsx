"use client";

import { useRef, useState, useSyncExternalStore, type FormEvent } from "react";

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

  const field = "mt-1 block w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 dark:border-zinc-700";
  return (
    <form method="post" onSubmit={submit} className="flex flex-col gap-4" aria-busy={pending}>
      {error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      ) : null}
      <label className="text-sm font-medium">
        Email
        <input
          name="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className={field}
        />
      </label>
      <label className="text-sm font-medium">
        Password
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={field}
        />
      </label>
      <button
        type="submit"
        disabled={!ready || pending}
        className="rounded-md bg-zinc-900 px-4 py-2 font-medium text-white disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900"
      >
        Accedi
      </button>
    </form>
  );
}
