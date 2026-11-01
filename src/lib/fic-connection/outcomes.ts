/**
 * Outcomes of the Fatture in Cloud OAuth callback. The callback always answers with a 303
 * to the settings page with `?esito=<code>`; the page (ticket of the settings UI) shows the
 * Italian message of the code. Codes are stable and machine-readable.
 */

/** Path of the Fatture in Cloud settings page (the page itself comes with the UI ticket). */
export const FIC_SETTINGS_PATH = "/impostazioni/fatture-in-cloud";

export const FIC_CALLBACK_OUTCOMES = {
  /** Linked to the user's only company. */
  connected: "Account Fatture in Cloud collegato",
  /** The user has several companies: choose which one to link. */
  pending_company_selection: "Scegli l'azienda di Fatture in Cloud da collegare",
  /** The user refused on FiC (`error=access_denied`). */
  access_denied: "Collegamento annullato",
  /** FiC answered with another OAuth error. */
  authorization_failed: "Fatture in Cloud non ha autorizzato il collegamento. Riprova",
  /** `state` missing, malformed, unknown, expired, already used, or of another user or tenant. */
  invalid_state: "Il link di collegamento non è valido o è scaduto. Riprova dalla pagina delle impostazioni",
  /** The code could not be exchanged (missing or malformed, FiC 4xx/5xx, invalid response). */
  token_exchange_failed: "Non è stato possibile completare il collegamento con Fatture in Cloud. Riprova",
  /** `/user/companies` failed or answered something not valid. */
  companies_failed: "Non è stato possibile leggere le aziende del tuo account Fatture in Cloud. Riprova",
  /** The FiC user has no company. */
  no_company: "Il tuo account Fatture in Cloud non ha nessuna azienda da collegare",
  /** The company is linked to another Vistato account. */
  company_already_linked: "Questa azienda di Fatture in Cloud è già collegata a un altro account Vistato",
  /** The tenant got connected meanwhile (e.g. by another callback). */
  already_connected: "La tua azienda è già collegata a Fatture in Cloud",
} as const;

export type FicCallbackOutcome = keyof typeof FIC_CALLBACK_OUTCOMES;

/** The Italian message of an outcome code, or null for an unknown code (never echo it). */
export function ficCallbackMessage(code: unknown): string | null {
  return typeof code === "string" && Object.hasOwn(FIC_CALLBACK_OUTCOMES, code)
    ? FIC_CALLBACK_OUTCOMES[code as FicCallbackOutcome]
    : null;
}

/** Relative URL the callback redirects to. */
export function ficSettingsUrl(outcome: FicCallbackOutcome): string {
  return `${FIC_SETTINGS_PATH}?esito=${outcome}`;
}
