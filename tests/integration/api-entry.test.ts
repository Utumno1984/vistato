import { beforeEach, describe, expect, it } from "vitest";

import { createTenant } from "@/db/platform/tenants";
import { forTenant, type UserRole } from "@/db/tenant-scope";
import { apiEntryResource } from "@/lib/api-entry";
import { hasLink } from "@/lib/hateoas";

import { testDb } from "../helpers/db";

let tenantA: string;
let tenantB: string;

beforeEach(async () => {
  tenantA = (await createTenant({ businessName: "Acme S.r.l.", vatNumber: "12345678903" }, testDb())).id;
  tenantB = (await createTenant({ businessName: "Beta S.r.l.", taxCode: "RSSMRA80A01H501U" }, testDb())).id;
});

const ROLES: UserRole[] = ["OWNER", "ADMIN", "USER"];

describe("apiEntryResource (the links the menu of the protected area follows)", () => {
  it("has fic-integration for every role when the tenant has the module, and not for another tenant", async () => {
    await forTenant(tenantA, testDb()).modules.activate("fic_iban_alert", {
      activatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    for (const role of ROLES) {
      const entry = await apiEntryResource({ user: { role }, tenant: { id: tenantA } });
      expect(hasLink(entry, "fic-integration"), role).toBe(true);
      const other = await apiEntryResource({ user: { role }, tenant: { id: tenantB } });
      expect(hasLink(other, "fic-integration"), role).toBe(false);
    }
  });

  it("has no fic-integration without the module, and for an anonymous caller", async () => {
    expect(hasLink(await apiEntryResource({ user: { role: "OWNER" }, tenant: { id: tenantA } }), "fic-integration")).toBe(false);
    const anonymous = await apiEntryResource(null);
    expect(hasLink(anonymous, "fic-integration")).toBe(false);
    expect(hasLink(anonymous, "login")).toBe(true);
    expect(hasLink(anonymous, "me")).toBe(false);
  });
});
