import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { safeNextPath } from "@/lib/auth/next-path";
import { getSessionFromCookies } from "@/lib/auth/session";

import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Accedi · Vistato" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  // Already signed in: nothing to do here.
  if (await getSessionFromCookies()) redirect("/fatture");
  const { next } = await searchParams;
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Accedi</h1>
      <LoginForm next={safeNextPath(Array.isArray(next) ? next[0] : next)} />
    </main>
  );
}
