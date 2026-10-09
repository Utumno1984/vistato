"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";

import {
  describeUploadResponse,
  MAX_UPLOAD_BYTES,
  UPLOAD_FALLBACK_MESSAGE,
} from "@/lib/invoices/upload-messages";

import { uploadInvoiceAction } from "./actions";

/**
 * "Carica fattura": sends the chosen XML to a Server Action that runs the same service as
 * `POST /api/invoices` (same checks, session and tenant). The page renders this form only
 * when the collection has the `upload-invoice` link. The file is checked by the server, so
 * the form has no HTML5 `required`.
 */
export function UploadForm() {
  const router = useRouter();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    messages: string[];
  } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setResult(null);
    const form = event.currentTarget;
    const file = new FormData(form).get("file");
    const body = new FormData();
    if (file instanceof File && file.name !== "") body.append("file", file);
    try {
      // A file past the limit is not sent: the server would refuse it with the same message.
      const outcome =
        file instanceof File && file.size > MAX_UPLOAD_BYTES
          ? describeUploadResponse(413, { error: "payload_too_large" })
          : await uploadInvoiceAction(body);
      if (outcome.kind === "unauthenticated") {
        window.location.assign("/login?next=%2Ffatture");
        return;
      }
      setResult({ ok: outcome.kind === "success", messages: outcome.messages });
      if (outcome.kind === "success") {
        form.reset();
        router.refresh();
      }
    } catch {
      setResult({ ok: false, messages: [UPLOAD_FALLBACK_MESSAGE] });
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="upload-title" className="mt-6">
      <h2 id="upload-title" className="text-lg font-medium">
        Carica fattura
      </h2>
      <form
        onSubmit={submit}
        noValidate
        className="mt-2 flex flex-wrap items-center gap-3"
      >
        <label className="text-sm">
          <span className="sr-only">File XML</span>
          <input
            type="file"
            name="file"
            accept=".xml,application/xml,text/xml"
            className="text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Carica
        </button>
      </form>
      {result ? (
        <div
          role={result.ok ? "status" : "alert"}
          className={`mt-2 text-sm ${result.ok ? "text-green-700" : "text-red-700"}`}
        >
          {result.messages.map((message, index) => (
            <p key={`${index}:${message}`}>{message}</p>
          ))}
        </div>
      ) : null}
    </section>
  );
}
