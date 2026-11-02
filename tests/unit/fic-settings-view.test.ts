import { describe, expect, it } from "vitest";

import { FIC_CALLBACK_OUTCOMES } from "@/lib/fic-connection/outcomes";
import { esitoNotice, MODULE_NOT_ACTIVE_MESSAGE, STATUS_HEADLINES } from "@/lib/fic-connection/settings-view";

describe("esitoNotice", () => {
  it("gives the Italian message of every outcome code of the callback", () => {
    for (const [code, message] of Object.entries(FIC_CALLBACK_OUTCOMES)) {
      expect(esitoNotice(code)?.message, code).toBe(message);
    }
  });

  it("uses role status for the good news and alert for the errors", () => {
    expect(esitoNotice("connected")?.role).toBe("status");
    expect(esitoNotice("pending_company_selection")?.role).toBe("status");
    for (const code of ["access_denied", "invalid_state", "token_exchange_failed", "company_already_linked", "no_company"]) {
      expect(esitoNotice(code)?.role, code).toBe("alert");
    }
  });

  it("treats cancelled as the user walking away, like access_denied", () => {
    expect(esitoNotice("cancelled")).toEqual({ role: "alert", message: "Collegamento annullato" });
  });

  it("gives nothing for unknown, differently cased, repeated, empty or inherited values", () => {
    for (const value of ["", "sconosciuto", "CONNECTED", "<b>x</b>", "__proto__", "constructor", "toString", ["connected", "cancelled"], undefined, null, 1]) {
      expect(esitoNotice(value), String(value)).toBeNull();
    }
  });
});

describe("settings texts", () => {
  it("has a headline for every state of the link", () => {
    expect(STATUS_HEADLINES.not_connected).toBe("Fatture in Cloud non collegato");
    expect(STATUS_HEADLINES.reauthorization_required).toBe(
      "Il collegamento è scaduto o è stato revocato: ricollega l'account",
    );
    expect(Object.keys(STATUS_HEADLINES).sort()).toEqual([
      "connected",
      "not_connected",
      "pending_company_selection",
      "reauthorization_required",
    ]);
  });

  it("says the module is not active in Italian", () => {
    expect(MODULE_NOT_ACTIVE_MESSAGE).toBe("Il modulo Alert cambio IBAN non è attivo per la tua azienda");
  });
});
