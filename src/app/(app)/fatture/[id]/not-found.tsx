import Link from "next/link";

export default function InvoiceNotFound() {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
      <h1 className="text-3xl font-semibold tracking-tight">Fattura non trovata</h1>
      <p className="mt-4">
        <Link href="/fatture" className="underline">
          Torna all&apos;elenco
        </Link>
      </p>
    </main>
  );
}
