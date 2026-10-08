import { afterAll, describe, expect, it } from "vitest";

import { closeDb } from "@/db/client";
import { DuplicateVatNumberError, TenantNotFoundError, ValidationError } from "@/db/errors";
import { createTenant, setTenantStatus, type CreateTenantInput } from "@/db/platform/tenants";
import { tenants } from "@/db/schema";

import { testDb, testSql } from "../helpers/db";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const cp = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
const NBSP = cp(0xa0);

async function tenantCount(): Promise<number> {
  const [{ count }] = await testSql()`select count(*)::int as count from tenants`;
  return count;
}

/** Runs `action`, expecting it to throw an instance of `type`, and returns the error. */
async function expectError<T extends Error>(action: Promise<unknown>, type: new (...args: never[]) => T): Promise<T> {
  const error = await action.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(type);
  return error as T;
}

function create(input: CreateTenantInput) {
  return createTenant(input, testDb());
}

describe("createTenant", () => {
  it("creates an ACTIVE tenant with a valid VAT number and returns it", async () => {
    const before = Date.now();
    const tenant = await create({ businessName: "Acme S.r.l.", vatNumber: "12345678903" });

    expect(tenant).toMatchObject({
      businessName: "Acme S.r.l.",
      vatNumber: "12345678903",
      taxCode: null,
      status: "ACTIVE",
    });
    expect(tenant.id).toMatch(UUID_V4);
    expect(tenant.createdAt).toBeInstanceOf(Date);
    expect(tenant.updatedAt).toBeInstanceOf(Date);
    // Generous bound: the database clock may differ slightly from the test runner's.
    expect(Math.abs(tenant.createdAt.getTime() - before)).toBeLessThan(60_000);

    const [row] = await testSql()`select * from tenants where id = ${tenant.id}`;
    expect(row).toMatchObject({ business_name: "Acme S.r.l.", vat_number: "12345678903", status: "ACTIVE" });
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.updated_at).toBeInstanceOf(Date);
  });

  it("uses the application database by default", async () => {
    const tenant = await createTenant({ businessName: "Default S.r.l.", vatNumber: "12345678903" });
    expect(await tenantCount()).toBe(1);
    const [row] = await testSql()`select id from tenants`;
    expect(row.id).toBe(tenant.id);
  });

  it("creates a tenant with only the tax code, leaving vat_number NULL", async () => {
    const tenant = await create({ businessName: "Mario Rossi", taxCode: "RSSMRA80A01H501U" });
    expect(tenant).toMatchObject({ vatNumber: null, taxCode: "RSSMRA80A01H501U", status: "ACTIVE" });

    const [row] = await testSql()`select vat_number, tax_code from tenants where id = ${tenant.id}`;
    expect(row).toEqual({ vat_number: null, tax_code: "RSSMRA80A01H501U" });
  });

  it("accepts null for the missing identifier", async () => {
    const tenant = await create({ businessName: "Mario Rossi", vatNumber: null, taxCode: "12345678901" });
    expect(tenant).toMatchObject({ vatNumber: null, taxCode: "12345678901" });
  });

  it("stores both identifiers when both are given", async () => {
    const tenant = await create({ businessName: "Acme S.r.l.", vatNumber: "12345678903", taxCode: "12345678903" });
    expect(tenant).toMatchObject({ vatNumber: "12345678903", taxCode: "12345678903" });
  });

  it("trims every field and upper-cases the tax code", async () => {
    const tenant = await create({
      businessName: `\t Acme S.r.l.${NBSP}${cp(0x200b)}\n`,
      vatNumber: " 12345678903 ",
      taxCode: "  rssmra80a01h501u ",
    });
    expect(tenant).toMatchObject({
      businessName: "Acme S.r.l.",
      vatNumber: "12345678903",
      taxCode: "RSSMRA80A01H501U",
    });
  });

  it("keeps accented letters and punctuation in the business name", async () => {
    const businessName = "Caffè & Più d'Italia S.r.l. - Società Benefit";
    const tenant = await create({ businessName, vatNumber: "12345678903" });
    expect(tenant.businessName).toBe(businessName);
  });

  it("rejects a VAT number with a wrong check digit, pointing at vatNumber, and inserts nothing", async () => {
    const error = await expectError(create({ businessName: "Acme S.r.l.", vatNumber: "12345678901" }), ValidationError);
    expect(error.fields).toEqual(["vatNumber"]);
    expect(await tenantCount()).toBe(0);
  });

  it.each(["IT12345678903", "12345 678903", "1234567890", "123456789031", "", `123456${cp(0)}78903`])(
    "rejects the VAT number %j",
    async (vatNumber) => {
      const error = await expectError(create({ businessName: "Acme S.r.l.", vatNumber }), ValidationError);
      expect(error.fields).toEqual(["vatNumber"]);
      expect(await tenantCount()).toBe(0);
    },
  );

  it.each([
    "RSSMRA80A01H501",
    "RSSMRA80A01H501UX",
    "RSSMRA80A01H50-U",
    "",
    `RSSMRA80${cp(0)}A01H501U`,
    // Non-ASCII characters that toUpperCase() turns into ASCII letters
    `rssmra80a01h50${cp(0xdf)}`, // sharp s, becomes SS
    `RSSMRA80A01H${cp(0xfb01)}01`, // fi ligature, becomes FI
    `RSSMRA80A01H501${cp(0x131)}`, // dotless i, becomes I
    `RSSMRA80A01H501${cp(0x17f)}`, // long s, becomes S
  ])("rejects the tax code %j", async (taxCode) => {
    const error = await expectError(create({ businessName: "Mario Rossi", taxCode }), ValidationError);
    expect(error.fields).toEqual(["taxCode"]);
    expect(await tenantCount()).toBe(0);
  });

  it.each([{}, { vatNumber: null, taxCode: null }, { vatNumber: undefined, taxCode: undefined }])(
    "rejects an input without VAT number or tax code (%j) and inserts nothing",
    async (ids) => {
      const error = await expectError(create({ businessName: "Acme S.r.l.", ...ids }), ValidationError);
      expect(error.fields).toEqual(["vatNumber", "taxCode"]);
      expect(await tenantCount()).toBe(0);
    },
  );

  it.each([
    ["empty", ""],
    ["spaces", "   "],
    ["tab", "\t"],
    ["line breaks", "\r\n\n"],
    ["NBSP", NBSP],
    ["mixed blanks", ` \t\n${NBSP}${cp(0x2003, 0x3000)}`],
    ["zero-width characters", cp(0x200b, 0xfeff, 0x2060)],
    ["soft hyphens", cp(0xad, 0xad)],
    ["Hangul fillers", cp(0x3164, 0x115f, 0x1160, 0xffa0)],
    ["invisible math operators", cp(0x2061, 0x2062, 0x2063, 0x2064)],
  ])("rejects a business name made of %s and inserts nothing", async (_label, businessName) => {
    const error = await expectError(create({ businessName, vatNumber: "12345678903" }), ValidationError);
    expect(error.fields).toEqual(["businessName"]);
    expect(await tenantCount()).toBe(0);
  });

  it.each([
    ["NUL", cp(0)],
    ["NUL only", cp(0, 0)],
    ["escape", cp(0x1b)],
    ["DEL", cp(0x7f)],
    ["C1 control", cp(0x9b)],
    ["inner tab", "\t"],
    ["inner line break", "\n"],
  ])("rejects a business name containing a control character (%s) with a ValidationError", async (label, chars) => {
    const businessName = label === "NUL only" ? chars : `Acme${chars}S.r.l.`;
    const error = await expectError(create({ businessName, vatNumber: "12345678903" }), ValidationError);
    expect(error.fields).toEqual(["businessName"]);
    // The error never echoes the input or the query parameters.
    expect(error.message).not.toContain("Acme");
    expect(error.message).not.toContain("12345678903");
    expect(await tenantCount()).toBe(0);
  });

  it.each([
    ["a lone surrogate", `Acme${String.fromCharCode(0xd800)}`],
    ["only a combining accent", cp(0x301)],
    ["only punctuation", ".-&"],
    ["a right-to-left override", `Acme ${cp(0x202e)}l.r.S`],
    ["a first strong isolate", `Acme${cp(0x2068)}S.r.l.`],
    ["a line separator", `Acme${cp(0x2028)}S.r.l.`],
    ["a paragraph separator", `Acme${cp(0x2029)}S.r.l.`],
    ["1001 characters", "a".repeat(1001)],
    ["5 million characters", `a${" ".repeat(5_000_000)}a`],
  ])("rejects a business name with %s and inserts nothing", async (_label, businessName) => {
    const error = await expectError(create({ businessName, vatNumber: "12345678903" }), ValidationError);
    expect(error.fields).toEqual(["businessName"]);
    expect(await tenantCount()).toBe(0);
  });

  it("stores the business name in NFC", async () => {
    const tenant = await create({ businessName: `Societa${cp(0x300)} Alfa`, vatNumber: "12345678903" });
    const [row] = await testSql()`select business_name from tenants where id = ${tenant.id}`;
    expect(row.business_name).toBe(`Societ${cp(0xe0)} Alfa`);
    expect(tenant.businessName).toBe(row.business_name);
  });

  it.each([
    "Società Àlfa d'Italia & C. S.n.c.",
    `Acme${NBSP}S.r.l.`,
    cp(0x6771, 0x4eac, 0x5546, 0x4e8b, 0x682a, 0x5f0f, 0x4f1a, 0x793e),
    "a".repeat(1000),
  ])("stores the legitimate business name %j unchanged", async (businessName) => {
    const tenant = await create({ businessName, vatNumber: "12345678903" });
    const [row] = await testSql()`select business_name from tenants where id = ${tenant.id}`;
    expect(row.business_name).toBe(businessName);
  });

  it.each([
    ["vatNumber", { vatNumber: `${" ".repeat(54)}12345678903` }],
    ["taxCode", { taxCode: `${" ".repeat(49)}RSSMRA80A01H501U` }],
  ])("rejects a %s longer than 64 characters before trimming", async (field, ids) => {
    const error = await expectError(create({ businessName: "Acme S.r.l.", ...ids }), ValidationError);
    expect(error.fields).toEqual([field]);
    expect(await tenantCount()).toBe(0);
  });

  it("documents why: the database CHECK alone accepts a business name of tabs and NBSPs", async () => {
    // btrim removes only ASCII spaces, so this row passes tenants_business_name_not_blank.
    await testSql()`insert into tenants (business_name, vat_number) values (${`\t${NBSP}\n`}, '12345678903')`;
    expect(await tenantCount()).toBe(1);
  });

  it.each([null, undefined, "Acme", 42, []])("rejects a non-object input (%j)", async (input) => {
    await expectError(create(input as unknown as CreateTenantInput), ValidationError);
    expect(await tenantCount()).toBe(0);
  });

  it("rejects non-string fields", async () => {
    const input = { businessName: 42, vatNumber: 12345678903 } as unknown as CreateTenantInput;
    const error = await expectError(create(input), ValidationError);
    expect(error.fields).toEqual(["businessName", "vatNumber"]);
  });

  it("throws DuplicateVatNumberError for a VAT number already in use, without creating the second tenant", async () => {
    const first = await create({ businessName: "Acme S.r.l.", vatNumber: "12345678903" });

    const error = await expectError(
      create({ businessName: "Acme Due S.r.l.", vatNumber: "12345678903" }),
      DuplicateVatNumberError,
    );
    expect(error.vatNumber).toBe("12345678903");

    const rows = await testSql()`select id, business_name from tenants`;
    expect(rows).toEqual([{ id: first.id, business_name: "Acme S.r.l." }]);
  });

  it("detects a duplicate after normalisation (edge spaces)", async () => {
    await create({ businessName: "Acme S.r.l.", vatNumber: "12345678903" });
    await expectError(create({ businessName: "Acme Due S.r.l.", vatNumber: " 12345678903 " }), DuplicateVatNumberError);
    expect(await tenantCount()).toBe(1);
  });

  it("allows several tenants without VAT number", async () => {
    await create({ businessName: "Mario Rossi", taxCode: "RSSMRA80A01H501U" });
    await create({ businessName: "Mario Rossi", taxCode: "RSSMRA80A01H501U" });
    expect(await tenantCount()).toBe(2);
  });

  it("lets exactly one of two concurrent creations with the same VAT number succeed", async () => {
    // Two separate connections, so the inserts really race inside Postgres.
    const results = await Promise.allSettled([
      createTenant({ businessName: "Acme Uno S.r.l.", vatNumber: "12345678903" }, testDb()),
      createTenant({ businessName: "Acme Due S.r.l.", vatNumber: "12345678903" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(DuplicateVatNumberError);

    const rows = await testSql()`select id from tenants`;
    expect(rows).toEqual([{ id: fulfilled[0].value.id }]);
  });

  it("ignores extra fields: the tenant is ACTIVE with database-generated id and timestamps", async () => {
    const forgedId = "00000000-0000-4000-8000-000000000000";
    const forgedDate = new Date("2000-01-01T00:00:00Z");
    const input = {
      businessName: "Acme S.r.l.",
      vatNumber: "12345678903",
      id: forgedId,
      status: "CLOSED",
      createdAt: forgedDate,
      updatedAt: forgedDate,
      tenantId: forgedId,
    } as CreateTenantInput;

    const tenant = await create(input);

    expect(tenant.id).not.toBe(forgedId);
    expect(tenant.id).toMatch(UUID_V4);
    expect(tenant.status).toBe("ACTIVE");
    expect(tenant.createdAt.getTime()).not.toBe(forgedDate.getTime());
    expect(tenant.updatedAt.getTime()).not.toBe(forgedDate.getTime());
    const [row] = await testSql()`select id, status from tenants`;
    expect(row).toEqual({ id: tenant.id, status: "ACTIVE" });
  });
});

describe("setTenantStatus", () => {
  /** created_at and updated_at in microseconds (JS dates stop at milliseconds). */
  async function timestamps(id: string): Promise<{ created: bigint; updated: bigint }> {
    const [row] = await testSql()`
      select (extract(epoch from created_at) * 1000000)::bigint as created,
             (extract(epoch from updated_at) * 1000000)::bigint as updated
      from tenants where id = ${id}`;
    return { created: BigInt(row.created), updated: BigInt(row.updated) };
  }

  it("sets SUSPENDED then CLOSED, moving updated_at forward each time", async () => {
    const tenant = await create({ businessName: "Acme S.r.l.", vatNumber: "12345678903" });
    const initial = await timestamps(tenant.id);

    const suspended = await setTenantStatus(tenant.id, "SUSPENDED", testDb());
    expect(suspended).toMatchObject({ id: tenant.id, status: "SUSPENDED" });
    expect(suspended.updatedAt.getTime()).toBeGreaterThanOrEqual(tenant.updatedAt.getTime());
    const afterSuspend = await timestamps(tenant.id);

    const closed = await setTenantStatus(tenant.id, "CLOSED", testDb());
    expect(closed).toMatchObject({ id: tenant.id, status: "CLOSED" });
    const afterClose = await timestamps(tenant.id);

    expect(afterSuspend.updated > initial.updated).toBe(true);
    expect(afterClose.updated > afterSuspend.updated).toBe(true);
    expect(afterClose.created).toBe(initial.created);
    const [row] = await testSql()`select status from tenants where id = ${tenant.id}`;
    expect(row.status).toBe("CLOSED");
  });

  it("strictly increases updated_at even when setting the same status back to back", async () => {
    const tenant = await create({ businessName: "Acme S.r.l.", vatNumber: "12345678903" });
    const values = [(await timestamps(tenant.id)).updated];
    for (let i = 0; i < 5; i++) {
      await setTenantStatus(tenant.id, "SUSPENDED", testDb());
      values.push((await timestamps(tenant.id)).updated);
    }
    for (let i = 1; i < values.length; i++) expect(values[i] > values[i - 1]).toBe(true);
  });

  it("allows any transition, e.g. CLOSED back to ACTIVE", async () => {
    const tenant = await create({ businessName: "Acme S.r.l.", vatNumber: "12345678903" });
    await setTenantStatus(tenant.id, "CLOSED", testDb());
    const reopened = await setTenantStatus(tenant.id, "ACTIVE");
    expect(reopened.status).toBe("ACTIVE");
  });

  it("changes only the given tenant", async () => {
    const a = await create({ businessName: "Acme S.r.l.", vatNumber: "12345678903" });
    const b = await create({ businessName: "Beta S.r.l.", taxCode: "RSSMRA80A01H501U" });
    await setTenantStatus(a.id, "SUSPENDED", testDb());

    const rows = await testDb().select({ id: tenants.id, status: tenants.status }).from(tenants);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === a.id)?.status).toBe("SUSPENDED");
    expect(rows.find((r) => r.id === b.id)?.status).toBe("ACTIVE");
  });

  async function snapshot() {
    return testSql()`select id, status, updated_at from tenants order by id`;
  }

  it("throws TenantNotFoundError for an unknown UUID and changes nothing", async () => {
    await create({ businessName: "Acme S.r.l.", vatNumber: "12345678903" });
    const before = await snapshot();
    const unknownId = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

    const error = await expectError(setTenantStatus(unknownId, "SUSPENDED", testDb()), TenantNotFoundError);
    expect(error.tenantId).toBe(unknownId);
    expect(await snapshot()).toEqual(before);
  });

  it.each(["not-a-uuid", "", "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5", "' or 1=1 --", `6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b${cp(0)}`])(
    "throws ValidationError for the non-UUID id %j and changes nothing",
    async (tenantId) => {
      await create({ businessName: "Acme S.r.l.", vatNumber: "12345678903" });
      const before = await snapshot();

      const error = await expectError(setTenantStatus(tenantId, "SUSPENDED", testDb()), ValidationError);
      expect(error.fields).toEqual(["tenantId"]);
      expect(await snapshot()).toEqual(before);
    },
  );

  it("throws ValidationError for an unknown status and changes nothing", async () => {
    const tenant = await create({ businessName: "Acme S.r.l.", vatNumber: "12345678903" });
    const before = await snapshot();

    const error = await expectError(
      setTenantStatus(tenant.id, "DELETED" as unknown as "ACTIVE", testDb()),
      ValidationError,
    );
    expect(error.fields).toEqual(["status"]);
    expect(await snapshot()).toEqual(before);
  });
});

// Close the application pool opened by the calls that rely on the default database.
afterAll(closeDb);
