import { FIC_CALLBACK_OUTCOMES, type FicCallbackOutcome } from "./outcomes";
import type { FicIntegrationStatus } from "./resource";

/** A message to show after the return from the OAuth callback. */
export interface EsitoNotice {
  /** `status` for good news, `alert` for something that needs the user's attention. */
  role: "status" | "alert";
  message: string;
}

const SUCCESS: ReadonlySet<string> = new Set<FicCallbackOutcome>(["connected", "pending_company_selection"]);

/**
 * The notice of `?esito=`. Only the known codes of the callback (plus `cancelled`, an alias of
 * `access_denied`: the user walked away) give a message; anything else, including a repeated
 * parameter, gives null and is never echoed in the page.
 */
export function esitoNotice(code: unknown): EsitoNotice | null {
  if (typeof code !== "string") return null;
  if (code === "cancelled") return { role: "alert", message: FIC_CALLBACK_OUTCOMES.access_denied };
  if (!Object.hasOwn(FIC_CALLBACK_OUTCOMES, code)) return null;
  const known = code as FicCallbackOutcome;
  return { role: SUCCESS.has(known) ? "status" : "alert", message: FIC_CALLBACK_OUTCOMES[known] };
}

/** The headline of the link state. */
export const STATUS_HEADLINES: Readonly<Record<FicIntegrationStatus, string>> = {
  not_connected: "Fatture in Cloud non collegato",
  connected: "Fatture in Cloud collegato",
  pending_company_selection: "Scegli l'azienda di Fatture in Cloud da collegare",
  reauthorization_required: "Il collegamento è scaduto o è stato revocato: ricollega l'account",
};

export const MODULE_NOT_ACTIVE_MESSAGE = "Il modulo Alert cambio IBAN non è attivo per la tua azienda";
