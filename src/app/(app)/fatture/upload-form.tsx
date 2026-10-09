"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from "react";

import { firstDroppedFile } from "@/lib/invoices/dropped-file";
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

  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState("");

  function syncName() {
    setFileName(inputRef.current?.files?.[0]?.name ?? "");
  }

  // Enter/leave counter: leaving a child of the area must not end the drag state.
  function onDragEnter(event: DragEvent) {
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }

  function onDragOver(event: DragEvent) {
    event.preventDefault();
  }

  function onDragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (busy.current) return;
    const file = firstDroppedFile(event.dataTransfer.files);
    const input = inputRef.current;
    if (!file || !input) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    syncName();
  }

  // Enter on a file input opens the chooser only through a native keypress default action,
  // which Chromium occasionally drops; open it explicitly from the keydown (a user activation).
  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || busy.current) return;
    event.preventDefault();
    event.currentTarget.click();
  }

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
        setFileName("");
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
        <label
          data-state={dragging ? "dragover" : fileName ? "selected" : "empty"}
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={`flex w-full max-w-md cursor-pointer flex-col items-center gap-1 rounded-md border-2 border-dashed px-4 py-6 text-center text-sm focus-within:ring-2 focus-within:ring-blue-500 ${
            dragging
              ? "border-blue-500 bg-blue-50 dark:bg-blue-950"
              : "border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          }`}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="h-8 w-8 text-zinc-500"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M12 16V4m0 0L8 8m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
          </svg>
          <span className="font-medium">
            {dragging
              ? "Rilascia il file qui"
              : "Trascina qui il file XML o clicca per scegliere"}
          </span>
          <span className="text-xs text-zinc-500">Solo .xml, massimo 5 MB</span>
          <span
            id="upload-file-name"
            aria-live="polite"
            className="max-w-full truncate text-xs font-medium"
          >
            {fileName}
          </span>
          <input
            ref={inputRef}
            type="file"
            name="file"
            aria-label="File XML"
            aria-describedby="upload-file-name"
            accept=".xml,application/xml,text/xml"
            onChange={syncName}
            onKeyDown={onInputKeyDown}
            className="sr-only"
          />
        </label>
        <a
          href="/esempi/fattura-esempio.xml"
          download
          className="text-sm underline"
        >
          Scarica un esempio
        </a>
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
