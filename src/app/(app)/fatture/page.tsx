import type { Metadata } from "next";

import { requirePageSession } from "@/lib/auth/page-session";

export const metadata: Metadata = { title: "Fatture · Vistato" };

/** Placeholder: the invoice list arrives with its own ticket. */
export default async function InvoicesPage() {
  await requirePageSession();
  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-10">
      <h1 className="text-3xl font-semibold tracking-tight">Fatture</h1>
      <p className="mt-3 text-zinc-600 dark:text-zinc-400">L&apos;elenco delle fatture sarà disponibile a breve.</p>
    </main>
  );
}
