import { describe, expect, it } from "vitest";

import type { FicConnection } from "@/db/tenant-scope";
import { FIC_CALLBACK_OUTCOMES, ficCallbackMessage, ficSettingsUrl } from "@/lib/fic-connection/outcomes";
import { blocksNewLink, toFicIntegrationResource } from "@/lib/fic-connection/resource";

const BASE: FicConnection = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "connected",
  companyId: 12345,
  companyName: "Acme S.r.l.",
  availableCompanies: null,
  scopes: "received_documents:r",
  accessTokenExpiresAt: new Date("2026-11-02T10:00:00.000Z"),
  connectedByUserId: "22222222-2222-4222-8222-222222222222",
  connectedAt: new Date("2026-11-01T10:00:00.000Z"),
  createdAt: new Date("2026-11-01T10:00:00.000Z"),
  updatedAt: new Date("2026-11-01T10:00:00.000Z"),
};
const BY = { id: BASE.connectedByUserId, firstName: "Mario", lastName: "Rossi" };
const PENDING: FicConnection = {
  ...BASE,
  status: "pending_company_selection",
  companyId: null,
  companyName: null,
  connectedAt: null,
  availableCompanies: [
    { id: 1, name: "Uno" },
    { id: 2, name: "Due" },
  ],
};

const rels = (r: { _links: object }) => Object.keys(r._links).sort();

describe("toFicIntegrationResource", () => {
  it("not connected: connect only for who can manage", () => {
    const manager = toFicIntegrationResource(null, { canManage: true }, null);
    expect(manager).toEqual({
      status: "not_connected",
      companyId: null,
      companyName: null,
      connectedAt: null,
      connectedBy: null,
      companies: null,
      _links: {
        self: { href: "/api/integrations/fic", title: "Fatture in Cloud" },
        connect: { href: "/api/integrations/fic/connect", method: "POST", title: "Collega Fatture in Cloud" },
      },
    });
    expect(rels(toFicIntegrationResource(null, { canManage: false }, null))).toEqual(["self"]);
  });

  it("pending: the choices and select-company only for who can manage, never connect", () => {
    const manager = toFicIntegrationResource(PENDING, { canManage: true }, BY);
    expect(manager).toMatchObject({ status: "pending_company_selection", companyId: null, connectedBy: null });
    expect(manager.companies).toEqual(PENDING.availableCompanies);
    // #59: a manager can also unlink a pending connection (DELETE works in every state).
    expect(rels(manager)).toEqual(["disconnect", "select-company", "self"]);
    expect(rels(toFicIntegrationResource(PENDING, { canManage: false }, BY))).toEqual(["self"]);
  });

  it("connected: company, UTC instant and who connected, only the self link, nothing else", () => {
    for (const canManage of [true, false]) {
      const r = toFicIntegrationResource(BASE, { canManage }, BY);
      expect(r).toEqual({
        status: "connected",
        companyId: 12345,
        companyName: "Acme S.r.l.",
        connectedAt: "2026-11-01T10:00:00.000Z",
        connectedBy: BY,
        companies: null,
        // #59: besides self, only the disconnect link, and only for who can manage.
        _links: {
          self: { href: "/api/integrations/fic", title: "Fatture in Cloud" },
          ...(canManage
            ? { disconnect: { href: "/api/integrations/fic", method: "DELETE", title: "Scollega Fatture in Cloud" } }
            : {}),
        },
      });
    }
  });

  it("never exposes tokens, scopes, verifier or state even if the connection object carried them", () => {
    const leaky = { ...BASE, accessTokenEnc: "v1:x", refreshTokenEnc: "v1:y", codeVerifier: "z", state: "s" } as FicConnection;
    const text = JSON.stringify(toFicIntegrationResource(leaky, { canManage: true }, BY));
    for (const word of ["token", "Token", "verifier", "state\"", "scopes", "v1:"]) expect(text).not.toContain(word);
  });
});

describe("toFicIntegrationResource after #59 (disconnect, reauthorization_required)", () => {
  const REAUTH: FicConnection = { ...BASE, status: "reauthorization_required", accessTokenExpiresAt: null };
  const DISCONNECT = { href: "/api/integrations/fic", method: "DELETE", title: "Scollega Fatture in Cloud" };

  it("exposes disconnect (DELETE /api/integrations/fic) to who can manage in every state with a link, never without one", () => {
    for (const connection of [BASE, PENDING, REAUTH]) {
      expect(toFicIntegrationResource(connection, { canManage: true }, BY)._links.disconnect, connection.status).toEqual(DISCONNECT);
      expect(toFicIntegrationResource(connection, { canManage: false }, BY)._links, connection.status).not.toHaveProperty(
        "disconnect",
      );
    }
    expect(toFicIntegrationResource(null, { canManage: true }, null)._links).not.toHaveProperty("disconnect");
  });

  it("reauthorization_required: the company still shown, connect and disconnect for who can manage, self only otherwise", () => {
    const manager = toFicIntegrationResource(REAUTH, { canManage: true }, BY);
    expect(manager).toEqual({
      status: "reauthorization_required",
      companyId: 12345,
      companyName: "Acme S.r.l.",
      connectedAt: null,
      connectedBy: null,
      companies: null,
      _links: {
        self: { href: "/api/integrations/fic", title: "Fatture in Cloud" },
        connect: { href: "/api/integrations/fic/connect", method: "POST", title: "Collega Fatture in Cloud" },
        disconnect: DISCONNECT,
      },
    });
    expect(rels(toFicIntegrationResource(REAUTH, { canManage: false }, BY))).toEqual(["self"]);
  });

  it("blocksNewLink: only a connected or pending link blocks a new authorization", () => {
    expect(blocksNewLink(null)).toBe(false);
    expect(blocksNewLink(REAUTH)).toBe(false);
    expect(blocksNewLink(BASE)).toBe(true);
    expect(blocksNewLink(PENDING)).toBe(true);
  });
});

describe("callback outcomes", () => {
  it("map access_denied to Collegamento annullato and give a message for every code", () => {
    expect(ficCallbackMessage("access_denied")).toBe("Collegamento annullato");
    for (const code of Object.keys(FIC_CALLBACK_OUTCOMES)) expect(ficCallbackMessage(code)).toBeTruthy();
    for (const unknown of ["", "toString", "__proto__", "<script>", 5, null]) expect(ficCallbackMessage(unknown)).toBeNull();
  });

  it("redirect to the settings page with the code", () => {
    expect(ficSettingsUrl("company_already_linked")).toBe("/impostazioni/fatture-in-cloud?esito=company_already_linked");
  });
});
