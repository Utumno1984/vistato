import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { GET as getInvoice } from "@/app/api/invoices/[id]/route";
import * as approveRoute from "@/app/api/invoices/[id]/approve/route";
import * as rejectRoute from "@/app/api/invoices/[id]/reject/route";
import { GET as listInvoices } from "@/app/api/invoices/route";
import { createSession } from "@/db/auth";
import { UserNotInTenantError, ValidationError } from "@/db/errors";
import { createTenant } from "@/db/platform/tenants";
import { invoices } from "@/db/schema";
import { forTenant, type CreateInvoiceInput, type UserRole } from "@/db/tenant-scope";

import { randomVatNumber } from "../../e2e/helpers/create-test-tenant";
import { testDb } from "../helpers/db";

const BASE = "http://localhost:3100";
const UNKNOWN_UUID = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

const input = (n: number): CreateInvoiceInput => ({
  documentType: "TD01",
  supplierName: "Forniture Rossi",
  supplierVatCountry: "IT",
  supplierVatCode: "01234567890",
  invoiceNumber: `N-${n}`,
  invoiceDate: "2026-03-15",
  totalAmountCents: n === 0 ? 0 : -n,
  currency: "EUR",
});

interface Actor {
  id: string;
  token: string;
}
interface Ctx {
  tenantId: string;
  admin: Actor;
  owner: Actor;
  user: Actor;
  invoiceId: string;
}

const scope = (tenantId: string) => forTenant(tenantId, testDb());

async function makeTenant(): Promise<Ctx> {
  const vat = randomVatNumber();
  const tenant = await createTenant({ businessName: `T ${vat}`, vatNumber: vat }, testDb());
  const actor = async (role: UserRole, firstName: string): Promise<Actor> => {
    const user = await scope(tenant.id).users.create({
      email: `${role.toLowerCase()}-${vat}@example.com`,
      firstName,
      lastName: "Test",
      role,
      status: "ACTIVE",
    });
    return { id: user.id, token: await createSession(user.id, tenant.id, testDb()) };
  };
  const [admin, owner, user] = [await actor("ADMIN", "Ada"), await actor("OWNER", "Olga"), await actor("USER", "Ugo")];
  const invoice = await scope(tenant.id).invoices.create(input(1), user.id);
  return { tenantId: tenant.id, admin, owner, user, invoiceId: invoice.id };
}

let a: Ctx;
let b: Ctx;

beforeEach(async () => {
  a = await makeTenant();
  b = await makeTenant();
});

function call(
  action: "approve" | "reject",
  token: string | undefined,
  id: string,
  options: { body?: string; headers?: Record<string, string> } = {},
) {
  const route = action === "approve" ? approveRoute : rejectRoute;
  return route.POST(
    new Request(`${BASE}/api/invoices/${id}/${action}`, {
      method: "POST",
      headers: { ...(token ? { cookie: `vistato_session=${token}` } : {}), ...options.headers },
      body: options.body,
    }),
    { params: Promise.resolve({ id }) },
  );
}

const row = async (id: string) => (await testDb().select().from(invoices).where(eq(invoices.id, id)))[0];
const cookie = (token: string) => ({ headers: { cookie: `vistato_session=${token}` } });

describe("invoices.decide (data layer)", () => {
  it("approves with one UPDATE: status, decider and instant set, reason ignored", async () => {
    const result = await scope(a.tenantId).invoices.decide(a.invoiceId, {
      decision: "APPROVED",
      userId: a.admin.id,
      reason: "ignored",
    });
    expect(result.outcome).toBe("decided");
    const saved = await row(a.invoiceId);
    expect(saved).toMatchObject({ status: "APPROVED", decidedByUserId: a.admin.id, rejectionReason: null });
    expect(saved.decidedAt).toBeInstanceOf(Date);
  });

  it("rejects with a trimmed reason; blank or missing means null", async () => {
    const s = scope(a.tenantId);
    const ids = [a.invoiceId, (await s.invoices.create(input(2), a.user.id)).id, (await s.invoices.create(input(3), a.user.id)).id];
    const reasons = ["  Importo errato  ", "   \t ", undefined];
    for (const [i, reason] of reasons.entries()) {
      await s.invoices.decide(ids[i], { decision: "REJECTED", userId: a.owner.id, reason });
    }
    expect((await row(ids[0])).rejectionReason).toBe("Importo errato");
    expect((await row(ids[1])).rejectionReason).toBeNull();
    expect((await row(ids[2])).rejectionReason).toBeNull();
  });

  it("refuses a reason over 1000 characters or not a string, leaving the invoice PENDING", async () => {
    const s = scope(a.tenantId);
    await expect(
      s.invoices.decide(a.invoiceId, { decision: "REJECTED", userId: a.admin.id, reason: "x".repeat(1001) }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      s.invoices.decide(a.invoiceId, { decision: "REJECTED", userId: a.admin.id, reason: 5 as unknown as string }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect((await row(a.invoiceId)).status).toBe("PENDING");
    expect((await s.invoices.decide(a.invoiceId, { decision: "REJECTED", userId: a.admin.id, reason: "x".repeat(1000) })).outcome).toBe("decided");
  });

  it("does not touch an invoice of another tenant: same not_found as an unknown ID or a non-UUID", async () => {
    const s = scope(a.tenantId);
    for (const id of [b.invoiceId, UNKNOWN_UUID, "nope"]) {
      expect((await s.invoices.decide(id, { decision: "APPROVED", userId: a.admin.id })).outcome).toBe("not_found");
    }
    expect((await row(b.invoiceId)).status).toBe("PENDING");
  });

  it("refuses a decider of another tenant (composite foreign key) and keeps the invoice PENDING", async () => {
    await expect(
      scope(a.tenantId).invoices.decide(a.invoiceId, { decision: "APPROVED", userId: b.admin.id }),
    ).rejects.toBeInstanceOf(UserNotInTenantError);
    expect((await row(a.invoiceId)).status).toBe("PENDING");
  });

  it("reports already_decided and keeps decision, decider and instant unchanged", async () => {
    const s = scope(a.tenantId);
    await s.invoices.decide(a.invoiceId, { decision: "APPROVED", userId: a.admin.id });
    const before = await row(a.invoiceId);
    const again = await s.invoices.decide(a.invoiceId, { decision: "REJECTED", userId: a.owner.id, reason: "late" });
    expect(again.outcome).toBe("already_decided");
    expect(await row(a.invoiceId)).toEqual(before);
  });

  it("with concurrent decisions exactly one wins", async () => {
    const s = scope(a.tenantId);
    const results = await Promise.all([
      s.invoices.decide(a.invoiceId, { decision: "APPROVED", userId: a.admin.id }),
      s.invoices.decide(a.invoiceId, { decision: "REJECTED", userId: a.owner.id }),
      s.invoices.decide(a.invoiceId, { decision: "APPROVED", userId: a.owner.id }),
    ]);
    expect(results.filter((r) => r.outcome === "decided")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "already_decided")).toHaveLength(2);
  });
});

describe("POST /api/invoices/{id}/approve and /reject", () => {
  it("lets ADMIN and OWNER approve, answering the resource with decider and no approve/reject links", async () => {
    for (const [who, ctxInvoice] of [
      [a.admin, a.invoiceId],
      [a.owner, (await scope(a.tenantId).invoices.create(input(2), a.user.id)).id],
    ] as const) {
      const res = await call("approve", who.token, ctxInvoice);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ id: ctxInvoice, status: "APPROVED", rejectionReason: null });
      expect(body.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(body.decidedBy).toEqual({ id: who.id, firstName: who === a.admin ? "Ada" : "Olga", lastName: "Test" });
      expect(body._links).not.toHaveProperty("approve");
      expect(body._links).not.toHaveProperty("reject");
    }
  });

  it("rejects with the reason; no body, an empty body or a blank reason give null", async () => {
    const s = scope(a.tenantId);
    const ids = await Promise.all([1, 2, 3, 4].map(async (n) => (await s.invoices.create(input(10 + n), a.user.id)).id));
    const bodies = [JSON.stringify({ reason: "Importo errato" }), undefined, "", JSON.stringify({ reason: "  " })];
    const expected = ["Importo errato", null, null, null];
    for (const [i, body] of bodies.entries()) {
      const res = await call("reject", a.admin.token, ids[i], { body });
      expect(res.status, String(i)).toBe(200);
      expect(await res.json()).toMatchObject({ status: "REJECTED", rejectionReason: expected[i] });
    }
  });

  it("ignores a reason sent with approve, even an invalid one", async () => {
    const res = await call("approve", a.admin.token, a.invoiceId, { body: JSON.stringify({ reason: 7 }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "APPROVED", rejectionReason: null });
  });

  it("answers 400 for a reason over 1000 characters, a non-string, a non-JSON or non-object body; invoice stays PENDING", async () => {
    const bad = [
      JSON.stringify({ reason: "x".repeat(1001) }),
      JSON.stringify({ reason: 42 }),
      JSON.stringify({ reason: null }),
      "not json",
      JSON.stringify(["x"]),
      "null",
    ];
    for (const body of bad) {
      const res = await call("reject", a.admin.token, a.invoiceId, { body });
      expect(res.status, body.slice(0, 20)).toBe(400);
      expect((await res.json()).error).toBe("invalid_request");
    }
    expect((await row(a.invoiceId)).status).toBe("PENDING");
  });

  it("answers 400, not 500, for a reason with NUL, control, bidi or lone surrogate characters; invoice stays PENDING", async () => {
    const bad = ["a\u0000b", "a\u0007b", "a\u0085b", "a‮b", "a⁦b", "a\uD800b", "a\uDC00"];
    for (const reason of bad) {
      const res = await call("reject", a.admin.token, a.invoiceId, { body: JSON.stringify({ reason }) });
      expect(res.status, JSON.stringify(reason)).toBe(400);
      expect((await res.json()).error).toBe("invalid_request");
      await expect(
        scope(a.tenantId).invoices.decide(a.invoiceId, { decision: "REJECTED", userId: a.admin.id, reason }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    expect((await row(a.invoiceId)).status).toBe("PENDING");
  });

  it("accepts tabs and line breaks in the reason and stores it NFC-normalised and trimmed", async () => {
    const res = await call("reject", a.admin.token, a.invoiceId, {
      body: JSON.stringify({ reason: " Riga 1\n\tRiga 2 café " }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).rejectionReason).toBe("Riga 1\n\tRiga 2 café");
  });

  it("answers 413 for a reject body over 8 KB, even if the reason alone would be fine", async () => {
    const res = await call("reject", a.admin.token, a.invoiceId, {
      body: JSON.stringify({ reason: "ok", padding: "x".repeat(9000) }),
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("payload_too_large");
    expect((await row(a.invoiceId)).status).toBe("PENDING");
  });

  it("shows decidedBy null on a PENDING invoice", async () => {
    const res = await getInvoice(new Request(`${BASE}/api/invoices/${a.invoiceId}`, cookie(a.admin.token)), {
      params: Promise.resolve({ id: a.invoiceId }),
    });
    expect((await res.json()).decidedBy).toBeNull();
  });

  it("answers 403 forbidden to a USER for approve and reject, leaving the invoice PENDING", async () => {
    for (const action of ["approve", "reject"] as const) {
      const res = await call(action, a.user.token, a.invoiceId);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("forbidden");
    }
    expect((await row(a.invoiceId)).status).toBe("PENDING");
  });

  it("answers 409 invoice_already_decided on a decided invoice and changes nothing", async () => {
    await call("approve", a.admin.token, a.invoiceId);
    const before = await row(a.invoiceId);
    for (const action of ["approve", "reject"] as const) {
      const res = await call(action, a.owner.token, a.invoiceId, { body: JSON.stringify({ reason: "x" }) });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("invoice_already_decided");
    }
    expect(await row(a.invoiceId)).toEqual(before);
  });

  it("answers a USER 403 even on a decided invoice, and 404 before 403 for a foreign invoice", async () => {
    await call("approve", a.admin.token, a.invoiceId);
    expect((await call("approve", a.user.token, a.invoiceId)).status).toBe(403);
    expect((await call("approve", a.user.token, b.invoiceId)).status).toBe(404);
  });

  it("answers the same 404 for another tenant's invoice, an unknown ID and a non-UUID", async () => {
    const bodies = [];
    for (const id of [b.invoiceId, UNKNOWN_UUID, "not-a-uuid"]) {
      for (const action of ["approve", "reject"] as const) {
        const res = await call(action, a.admin.token, id);
        expect(res.status).toBe(404);
        bodies.push(await res.json());
      }
    }
    expect(new Set(bodies.map((x) => JSON.stringify(x))).size).toBe(1);
    expect((await row(b.invoiceId)).status).toBe("PENDING");
  });

  it("answers 401 without a session and 403 forbidden_origin for a foreign Origin", async () => {
    expect((await call("approve", undefined, a.invoiceId)).status).toBe(401);
    expect((await call("reject", "x".repeat(43), a.invoiceId)).status).toBe(401);
    const res = await call("approve", a.admin.token, a.invoiceId, { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("forbidden_origin");
    expect((await call("approve", a.admin.token, a.invoiceId, { headers: { origin: BASE } })).status).toBe(200);
  });

  it("exports only POST: GET is a 405 handled by the framework", () => {
    expect(Object.keys(approveRoute)).toEqual(["POST"]);
    expect(Object.keys(rejectRoute)).toEqual(["POST"]);
  });

  it("with two concurrent requests answers 200 to one and 409 to the other", async () => {
    const pairs: Array<["approve" | "reject", "approve" | "reject"]> = [
      ["approve", "approve"],
      ["approve", "reject"],
    ];
    for (const [i, [first, second]] of pairs.entries()) {
      const id = (await scope(a.tenantId).invoices.create(input(30 + i), a.user.id)).id;
      const statuses = (
        await Promise.all([call(first, a.admin.token, id), call(second, a.owner.token, id)])
      ).map((r) => r.status);
      expect(statuses.sort()).toEqual([200, 409]);
    }
  });

  it("changes the role at every request: a downgraded ADMIN gets 403", async () => {
    await scope(a.tenantId).users.update(a.admin.id, { role: "USER" });
    expect((await call("approve", a.admin.token, a.invoiceId)).status).toBe(403);
    expect((await row(a.invoiceId)).status).toBe("PENDING");
  });

  it("approves a zero-amount invoice and one uploaded by the same user", async () => {
    const zero = await scope(a.tenantId).invoices.create(input(0), a.admin.id);
    expect((await call("approve", a.admin.token, zero.id)).status).toBe(200);
  });
});

describe("approval links in GET /api/invoices and /api/invoices/{id}", () => {
  const getOne = (token: string, id: string) =>
    getInvoice(new Request(`${BASE}/api/invoices/${id}`, cookie(token)), { params: Promise.resolve({ id }) });
  const list = (token: string) => listInvoices(new Request(`${BASE}/api/invoices`, cookie(token)));

  it("shows approve and reject with href and POST to ADMIN and OWNER on a PENDING invoice, not to USER", async () => {
    for (const who of [a.admin, a.owner]) {
      const { _links } = await (await getOne(who.token, a.invoiceId)).json();
      expect(_links.approve).toMatchObject({ method: "POST", href: `/api/invoices/${a.invoiceId}/approve` });
      expect(_links.reject).toMatchObject({ method: "POST", href: `/api/invoices/${a.invoiceId}/reject` });
    }
    const { _links } = await (await getOne(a.user.token, a.invoiceId)).json();
    expect(_links).not.toHaveProperty("approve");
    expect(_links).not.toHaveProperty("reject");
  });

  it("drops the links after the decision and lists the same links and decider in the collection", async () => {
    const extra = await scope(a.tenantId).invoices.create(input(2), a.user.id);
    await call("reject", a.admin.token, a.invoiceId, { body: JSON.stringify({ reason: "No" }) });
    const body = await (await list(a.admin.token)).json();
    const byId = new Map<string, { _links: Record<string, unknown>; decidedBy?: unknown }>(
      body._embedded.invoices.map((i: { id: string }) => [i.id, i]),
    );
    expect(byId.get(a.invoiceId)!._links).not.toHaveProperty("approve");
    expect(byId.get(a.invoiceId)!.decidedBy).toEqual({ id: a.admin.id, firstName: "Ada", lastName: "Test" });
    expect(byId.get(extra.id)!._links).toHaveProperty("approve");
    expect(byId.get(extra.id)!._links).toHaveProperty("reject");
    const asUser = await (await list(a.user.token)).json();
    for (const i of asUser._embedded.invoices) expect(i._links).not.toHaveProperty("approve");
    const detail = await (await getOne(a.admin.token, a.invoiceId)).json();
    expect(detail).toEqual(byId.get(a.invoiceId));
  });
});
