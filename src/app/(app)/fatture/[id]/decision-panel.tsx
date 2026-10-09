"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";

import { decideInvoiceAction } from "./actions";

const REASON_MAX_LENGTH = 1000;
const FALLBACK_MESSAGE = "Operazione non riuscita, riprova.";

/**
 * Approve / reject buttons. The page shows the buttons (`canApprove`, `canReject`) only when the
 * invoice resource has the `approve` and `reject` links; the panel itself stays mounted so an
 * error (e.g. "already decided") remains visible while the page refreshes without the buttons.
 */
export function DecisionPanel({
  invoiceId,
  canApprove,
  canReject,
}: {
  invoiceId: string;
  canApprove: boolean;
  canReject: boolean;
}) {
  const router = useRouter();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "APPROVED" | "REJECTED") {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const outcome = await decideInvoiceAction(invoiceId, decision, decision === "REJECTED" ? reason : undefined);
      if (outcome.kind === "unauthenticated") {
        window.location.assign(`/login?next=${encodeURIComponent(`/fatture/${invoiceId}`)}`);
        return;
      }
      if (outcome.kind === "error") setError(outcome.message);
      else setRejecting(false);
      // Success or conflict alike: show the current state of the invoice.
      router.refresh();
    } catch {
      setError(FALLBACK_MESSAGE);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <section aria-label="Decisione" className="mt-6">
      {canApprove || canReject ? (
        <div className="flex flex-wrap gap-3">
          {canApprove ? (
            <Button type="button" variant="outline" disabled={pending} onClick={() => decide("APPROVED")}>
              Approva
            </Button>
          ) : null}
          {canReject && !rejecting ? (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setError(null);
                setRejecting(true);
              }}
            >
              Rifiuta
            </Button>
          ) : null}
        </div>
      ) : null}
      {canReject && rejecting ? (
        <form
          className="mt-3 flex max-w-xl flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void decide("REJECTED");
          }}
        >
          <label className="text-sm font-medium" htmlFor="rejection-reason">
            Motivo (facoltativo)
          </label>
          <textarea
            id="rejection-reason"
            name="reason"
            rows={4}
            maxLength={REASON_MAX_LENGTH}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="rounded-md border border-zinc-300 p-2 text-sm dark:border-zinc-700 dark:bg-transparent"
          />
          <div className="flex gap-3">
            <Button type="submit" variant="outline" disabled={pending}>
              Conferma rifiuto
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setRejecting(false);
                setReason("");
                setError(null);
              }}
            >
              Annulla
            </Button>
          </div>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </section>
  );
}
