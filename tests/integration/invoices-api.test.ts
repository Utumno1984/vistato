import { beforeEach, describe, expect, it } from "vitest";

import { GET as getApi } from "@/app/api/route";
import { GET as getInvoice } from "@/app/api/invoices/[id]/route";
import { POST as upload } from "@/app/api/invoices/route";
import { createSession } from "@/db/auth";
import { invoices } from "@/db/schema";
import { createTenant, setTenantStatus } from "@/db/platform/tenants";
import { forTenant } from "@/db/tenant-scope";

import { randomVatNumber } from "../../e2e/helpers/create-test-tenant";
import { buildFatturaPA } from "../fixtures/fatturapa/build";
import { testDb } from "../helpers/db";

const BASE = "http://localhost:3100";
const MB = 1024 * 1024;

let tenantA: string;
let tenantB: string;
let userA: string;
let userB: string;
let tokenA: string;
let tokenB: string;

async function makeTenant(role: "OWNER" | "ADMIN" | "USER" = "USER") {
  const vatNumber = randomVatNumber();
  const tenant = await createTenant({ businessName: `T ${vatNumber}`, vatNumber }, testDb());
  const user = await forTenant(tenant.id, testDb()).users.create({
    email: `u-${vatNumber}@example.com`,
    firstName: "U",
    lastName: "U",
    role,
    status: "ACTIVE",
  });
  const token = await createSession(user.id, tenant.id, testDb());
  return { tenantId: tenant.id, userId: user.id, token };
}

beforeEach(async () => {
  const a = await makeTenant();
  const b = await makeTenant();
  ({ tenantId: tenantA, userId: userA, token: tokenA } = a);
  ({ tenantId: tenantB, userId: userB, token: tokenB } = b);
});

function formWith(parts: Array<[string, string | Blob, string?]>): FormData {
  const form = new FormData();
  for (const [name, value, filename] of parts) {
    if (typeof value === "string") form.append(name, value);
    else form.append(name, value, filename);
  }
  return form;
}

const xmlFile = (xml: string | Uint8Array = buildFatturaPA(), name = "fattura.xml") =>
  [["file", new Blob([xml as BlobPart], { type: "text/xml" }), name]] as Array<[string, Blob, string]>;

function send(token: string | undefined, body: BodyInit | null, headers: Record<string, string> = {}) {
  return upload(
    new Request(`${BASE}/api/invoices`, {
      method: "POST",
      headers: { ...(token ? { cookie: `vistato_session=${token}` } : {}), ...headers },
      body,
    }),
  );
}

const sendForm = (token: string | undefined, parts: Array<[string, string | Blob, string?]>, headers: Record<string, string> = {}) =>
  send(token, formWith(parts), headers);

const get = (token: string | undefined, id: string) =>
  getInvoice(new Request(`${BASE}/api/invoices/${id}`, { headers: token ? { cookie: `vistato_session=${token}` } : {} }), {
    params: Promise.resolve({ id }),
  });

const count = async () => (await testDb().select().from(invoices)).length;

describe("POST /api/invoices", () => {
  it("creates a PENDING invoice with Location and the resource, and GET self returns the same", async () => {
    const res = await sendForm(tokenA, xmlFile());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(res.headers.get("location")).toBe(`/api/invoices/${body.id}`);
    expect(body).toEqual({
      id: expect.any(String),
      documentType: "TD01",
      supplier: { name: "Caffè & Co. S.r.l.", vatCountry: "IT", vatCode: "01234567890" },
      number: "FT/2024/001",
      date: "2024-02-29",
      total: { amountCents: 123450, currency: "EUR" },
      status: "PENDING",
      uploadedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      decidedAt: null,
      rejectionReason: null,
      _links: { self: { href: `/api/invoices/${body.id}` } },
    });
    const again = await get(tokenA, body.id);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(body);
    const [row] = await testDb().select().from(invoices);
    expect(row.tenantId).toBe(tenantA);
    expect(row.uploadedByUserId).toBe(userA);
  });

  it("lets every role upload", async () => {
    for (const role of ["OWNER", "ADMIN", "USER"] as const) {
      const { token } = await makeTenant(role);
      expect((await sendForm(token, xmlFile())).status, role).toBe(201);
    }
  });

  it("answers 401 without a valid session and creates nothing", async () => {
    expect((await sendForm(undefined, xmlFile())).status).toBe(401);
    expect((await sendForm("x".repeat(43), xmlFile())).status).toBe(401);
    expect(await count()).toBe(0);
  });

  it("refuses a user DISABLED or a tenant SUSPENDED or CLOSED, creating nothing", async () => {
    await forTenant(tenantA, testDb()).users.update(userA, { status: "DISABLED" });
    expect((await sendForm(tokenA, xmlFile())).status).toBe(401);
    for (const status of ["SUSPENDED", "CLOSED"] as const) {
      await setTenantStatus(tenantB, status, testDb());
      expect((await sendForm(tokenB, xmlFile())).status, status).toBe(401);
    }
    expect(await count()).toBe(0);
  });

  it("answers 403 for a foreign Origin, 201 for the own one", async () => {
    expect((await sendForm(tokenA, xmlFile(), { origin: "https://evil.example" })).status).toBe(403);
    expect(await count()).toBe(0);
    expect((await sendForm(tokenA, xmlFile(), { origin: BASE })).status).toBe(201);
  });

  it("answers 422 invalid_invoice with the Italian issues for an impossible date, a batch, XXE and a signed file", async () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><FatturaElettronica>&a;</FatturaElettronica>`;
    const cases: Array<[string, string | Uint8Array]> = [
      ["date", buildFatturaPA({ date: "2025-02-30" })],
      ["batch", buildFatturaPA({ bodies: 2 })],
      ["xxe", xxe],
      ["p7m-content", new Uint8Array([0x30, 0x82, 0x01, 0x00, 0x06, 0x09])],
      ["binary", new Uint8Array([0x00, 0x01, 0x02, 0x03])],
    ];
    for (const [label, xml] of cases) {
      const res = await sendForm(tokenA, xmlFile(xml));
      expect(res.status, label).toBe(422);
      const body = await res.json();
      expect(body.error).toBe("invalid_invoice");
      expect(typeof body.message).toBe("string");
      expect(body.issues.length).toBeGreaterThan(0);
      expect(JSON.stringify(body)).not.toContain("root:");
    }
    const date = await (await sendForm(tokenA, xmlFile(buildFatturaPA({ date: "2025-02-30" })))).json();
    expect(date.issues).toEqual([{ field: "invoiceDate", message: "La data della fattura non è valida (formato AAAA-MM-GG)" }]);
    expect(await count()).toBe(0);
  });

  it("answers 400 without a file, with several files, not multipart, with an empty file or a text field named file", async () => {
    const cases: Array<[string, Response]> = [
      ["no file", await sendForm(tokenA, [["other", "x"]])],
      ["two files", await sendForm(tokenA, [...xmlFile(), ...xmlFile()])],
      ["json", await send(tokenA, JSON.stringify({ file: "x" }), { "content-type": "application/json" })],
      ["no content-type", await send(tokenA, "abc", { "content-type": "text/plain" })],
      ["empty file", await sendForm(tokenA, xmlFile(""))],
      ["text field", await sendForm(tokenA, [["file", "<xml/>"]])],
      ["broken multipart", await send(tokenA, "garbage", { "content-type": "multipart/form-data; boundary=zzz" })],
    ];
    for (const [label, res] of cases) {
      expect(res.status, label).toBe(400);
      expect((await res.json()).error, label).toBe("invalid_request");
    }
    expect(await count()).toBe(0);
  });

  it("answers 413 over 5 MB, declared or streamed without Content-Length, and accepts exactly 5 MB", async () => {
    const big = xmlFile(new Uint8Array(5 * MB + 1).fill(0x20));
    const declared = await sendForm(tokenA, big);
    expect(declared.status).toBe(413);
    expect((await declared.json()).error).toBe("payload_too_large");

    // Streamed with no Content-Length: the reader stops once the limit is passed.
    const form = formWith(big);
    const raw = new Uint8Array(await new Response(form).arrayBuffer());
    const contentType = new Response(form).headers.get("content-type")!;
    let pulled = 0;
    const chunk = 64 * 1024;
    const total = raw.byteLength + 20 * MB;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= total) return controller.close();
        controller.enqueue(pulled < raw.byteLength ? raw.subarray(pulled, pulled + chunk) : new Uint8Array(chunk));
        pulled += chunk;
      },
    });
    const streamed = await upload(
      new Request(`${BASE}/api/invoices`, {
        method: "POST",
        headers: { cookie: `vistato_session=${tokenA}`, "content-type": contentType },
        body: stream,
        duplex: "half",
      } as RequestInit),
    );
    expect(streamed.status).toBe(413);
    expect(pulled).toBeLessThan(total);
    expect(await count()).toBe(0);

    const xml = buildFatturaPA();
    const padded = xml.replace("</FatturaElettronica>", `${" ".repeat(5 * MB - new TextEncoder().encode(xml).byteLength)}</FatturaElettronica>`);
    expect((await sendForm(tokenA, xmlFile(padded))).status).toBe(201);
  });

  it("answers 415 in Italian for .p7m and other extensions, accepts .XML in any case, spaces and non-ASCII names", async () => {
    for (const name of ["f.xml.p7m", "f.p7m", "f.pdf", "f.txt", "f", "xml", ".xml.bak"]) {
      const res = await sendForm(tokenA, xmlFile(buildFatturaPA(), name));
      expect(res.status, name).toBe(415);
      expect((await res.json()).message).toMatch(/solo file XML/);
    }
    expect(await count()).toBe(0);
    const names = ["FATTURA.XML", "Fattura Maggio 2024.Xml", "fàttura è.xml"];
    for (const [i, name] of names.entries()) {
      expect((await sendForm(tokenA, xmlFile(buildFatturaPA({ number: `N${i}` }), name))).status, name).toBe(201);
    }
  });

  it("answers 409 duplicate_invoice with the link to the existing invoice; the same invoice in another tenant is created", async () => {
    const first = await (await sendForm(tokenA, xmlFile())).json();
    const dup = await sendForm(tokenA, xmlFile());
    expect(dup.status).toBe(409);
    const body = await dup.json();
    expect(body.error).toBe("duplicate_invoice");
    expect(body._links.self.href).toBe(`/api/invoices/${first.id}`);
    expect(await count()).toBe(1);
    expect((await sendForm(tokenB, xmlFile())).status).toBe(201);
  });

  it("treats a lowercase VAT country as the same supplier: 409, not a second invoice", async () => {
    expect((await sendForm(tokenA, xmlFile(buildFatturaPA({ vatCountry: "FR", vatCode: "ab123" })))).status).toBe(201);
    const dup = await sendForm(tokenA, xmlFile(buildFatturaPA({ vatCountry: "fr", vatCode: "ab123" })));
    expect(dup.status).toBe(409);
    expect(await count()).toBe(1);
    const [row] = await testDb().select().from(invoices);
    expect(row.supplierVatCountry).toBe("FR");
  });

  it("treats FR/ab123 and FR/AB123 (same number and date) as the same supplier: one row", async () => {
    const lower = await sendForm(tokenA, xmlFile(buildFatturaPA({ vatCountry: "FR", vatCode: "ab123" })));
    expect(lower.status).toBe(201);
    const upper = await sendForm(tokenA, xmlFile(buildFatturaPA({ vatCountry: "FR", vatCode: "AB123" })));
    expect(upper.status).toBe(409);
    expect((await upper.json())._links.self.href).toBe(`/api/invoices/${(await lower.json()).id}`);
    const mixed = await sendForm(tokenA, xmlFile(buildFatturaPA({ vatCountry: "fr", vatCode: "aB123" })));
    expect(mixed.status).toBe(409);
    expect(await count()).toBe(1);
    const [row] = await testDb().select().from(invoices);
    expect(row).toMatchObject({ supplierVatCountry: "FR", supplierVatCode: "AB123" });
  });

  it("refuses a Unicode look-alike country or code (ligature, dotless i) with 422", async () => {
    expect((await sendForm(tokenA, xmlFile(buildFatturaPA({ vatCountry: "ﬀ", vatCode: "123" })))).status).toBe(422);
    expect((await sendForm(tokenA, xmlFile(buildFatturaPA({ vatCountry: "ıt" })))).status).toBe(422);
    expect(await count()).toBe(0);
  });

  it("rejects early on a declared Content-Length over the limit, without reading the body", async () => {
    // The body is tiny and, if it were read, would be a 400 (broken multipart): only the header can give 413.
    const res = await upload(
      new Request(`${BASE}/api/invoices`, {
        method: "POST",
        headers: { cookie: `vistato_session=${tokenA}`, "content-type": "multipart/form-data; boundary=x", "content-length": "99999999" },
        body: "tiny",
      }),
    );
    expect(res.status).toBe(413);
    expect(await count()).toBe(0);
  });

  it("with two concurrent uploads of the same file creates one and answers 409 to the other", async () => {
    const statuses = (await Promise.all([sendForm(tokenA, xmlFile()), sendForm(tokenA, xmlFile())])).map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    expect(await count()).toBe(1);
  });

  it("ignores tenantId and status in the form", async () => {
    const res = await sendForm(tokenA, [...xmlFile(), ["tenantId", tenantB], ["status", "APPROVED"], ["uploadedByUserId", userB]]);
    expect(res.status).toBe(201);
    expect((await res.json()).status).toBe("PENDING");
    const [row] = await testDb().select().from(invoices);
    expect(row).toMatchObject({ tenantId: tenantA, status: "PENDING", uploadedByUserId: userA });
  });

  it("reads a BOM-prefixed file and keeps the sign of a credit note and zero", async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(buildFatturaPA({ number: "NC1", documentType: "TD04", total: "-50.00" }))]);
    const credit = await (await sendForm(tokenA, xmlFile(bom))).json();
    expect(credit).toMatchObject({ documentType: "TD04", total: { amountCents: -5000, currency: "EUR" } });
    const zero = await (await sendForm(tokenA, xmlFile(buildFatturaPA({ number: "Z", total: "0.00" })))).json();
    expect(zero.total.amountCents).toBe(0);
  });
});

describe("GET /api/invoices/{id}", () => {
  it("answers the same 404 for another tenant's invoice, an unknown ID, a non-UUID, upper case and spaces", async () => {
    const { id } = await (await sendForm(tokenA, xmlFile())).json();
    const unknown = await get(tokenB, "00000000-0000-4000-8000-000000000000");
    expect(unknown.status).toBe(404);
    const unknownBody = await unknown.json();
    expect(unknownBody).toEqual({ error: "not_found", message: expect.any(String) });
    const other = await get(tokenB, id);
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual(unknownBody);
    for (const bad of ["abc", "1", " " + id, id + " ", "' OR 1=1 --"]) {
      expect((await get(tokenA, bad)).status, bad).toBe(404);
    }
    // A UUID is case-insensitive: the upper-case form is the same invoice.
    expect((await get(tokenA, id.toUpperCase())).status).toBe(200);
  });

  it("answers 401 without a session", async () => {
    const { id } = await (await sendForm(tokenA, xmlFile())).json();
    expect((await get(undefined, id)).status).toBe(401);
  });
});

describe("GET /api link", () => {
  it("has upload-invoice for an authenticated caller and not for an anonymous one", async () => {
    const authed = await (await getApi(new Request(`${BASE}/api`, { headers: { cookie: `vistato_session=${tokenA}` } }))).json();
    expect(authed._links["upload-invoice"]).toEqual({ href: "/api/invoices", method: "POST", title: "Carica fattura" });
    const anon = await (await getApi(new Request(`${BASE}/api`))).json();
    expect(anon._links).not.toHaveProperty("upload-invoice");
  });
});
