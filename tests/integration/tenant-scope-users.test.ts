import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, type Database } from "@/db/client";
import { DuplicateEmailError, TenantNotFoundError, ValidationError } from "@/db/errors";
import { requireTestDatabaseUrl } from "@/db/migrate";
import { createTenant, setTenantStatus } from "@/db/platform/tenants";
import * as schema from "@/db/schema";
import { forTenant, type CreateUserInput, type UpdateUserInput } from "@/db/tenant-scope";

import { testDb, testSql } from "../helpers/db";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UNKNOWN_UUID = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const NON_UUID_IDS = ["not-a-uuid", "", "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5", "' or 1=1 --", `${UNKNOWN_UUID}\u0000`];

/** Runs `action`, expecting it to throw an instance of `type`, and returns the error. */
async function expectError<T extends Error>(action: Promise<unknown>, type: new (...args: never[]) => T): Promise<T> {
  const error = await action.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(type);
  return error as T;
}

const mario: CreateUserInput = { email: "mario@acme.it", firstName: "Mario", lastName: "Rossi", role: "OWNER" };
const luigi: CreateUserInput = { email: "luigi@acme.it", firstName: "Luigi", lastName: "Verdi", role: "USER" };

let tenantA: string;
let tenantB: string;

beforeEach(async () => {
  tenantA = (await createTenant({ businessName: "Acme S.r.l.", vatNumber: "12345678903" }, testDb())).id;
  tenantB = (await createTenant({ businessName: "Beta S.r.l.", taxCode: "RSSMRA80A01H501U" }, testDb())).id;
});

const scope = (tenantId: string) => forTenant(tenantId, testDb());

/** Every user row, raw, ordered: used to prove that nothing else changed. */
async function allUsers() {
  return testSql()`select * from users order by id`;
}

async function countUsers(tenantId?: string): Promise<number> {
  const [{ count }] = tenantId
    ? await testSql()`select count(*)::int as count from users where tenant_id = ${tenantId}`
    : await testSql()`select count(*)::int as count from users`;
  return count;
}

/** updated_at in microseconds (JS dates stop at milliseconds). */
async function updatedAtMicros(id: string): Promise<bigint> {
  const [row] = await testSql()`select (extract(epoch from updated_at) * 1000000)::bigint as updated from users where id = ${id}`;
  return BigInt(row.updated);
}

describe("forTenant", () => {
  it.each(NON_UUID_IDS)("throws ValidationError for the non-UUID tenant id %j", (tenantId) => {
    const error = (() => {
      try {
        scope(tenantId);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).fields).toEqual(["tenantId"]);
  });

  it("exposes the tenant ID it is bound to and cannot be rebound", () => {
    const a = scope(tenantA);
    expect(a.tenantId).toBe(tenantA);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.users)).toBe(true);
  });

  it("uses the application database by default", async () => {
    const user = await forTenant(tenantA).users.create(mario);
    expect(await countUsers(tenantA)).toBe(1);
    expect((await forTenant(tenantA).users.findById(user.id))?.email).toBe("mario@acme.it");
  });
});

describe("users.create", () => {
  it("saves the user in the tenant with status INVITED and returns it", async () => {
    const user = await scope(tenantA).users.create(mario);

    expect(user).toMatchObject({
      tenantId: tenantA,
      email: "mario@acme.it",
      firstName: "Mario",
      lastName: "Rossi",
      role: "OWNER",
      status: "INVITED",
    });
    expect(user.id).toMatch(UUID_V4);
    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeInstanceOf(Date);

    const rows = await allUsers();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: user.id, tenant_id: tenantA, email: "mario@acme.it", status: "INVITED" });
  });

  it("accepts an explicit status", async () => {
    const user = await scope(tenantA).users.create({ ...mario, status: "ACTIVE" });
    expect(user.status).toBe("ACTIVE");
  });

  it("trims names and email, keeping the email case as typed", async () => {
    const user = await scope(tenantA).users.create({
      email: "  Mario.Rossi@Acme.IT\t",
      firstName: "​ Mario ",
      lastName: " Rossi﻿",
      role: "ADMIN",
    });
    expect(user).toMatchObject({ email: "Mario.Rossi@Acme.IT", firstName: "Mario", lastName: "Rossi" });
  });

  it.each(["tenantId", "tenant_id"])("ignores %s in the input: the user is created in tenant A only", async (key) => {
    const input = { ...mario, [key]: tenantB } as CreateUserInput;

    const user = await scope(tenantA).users.create(input);

    expect(user.tenantId).toBe(tenantA);
    expect(await countUsers(tenantA)).toBe(1);
    expect(await countUsers(tenantB)).toBe(0);
  });

  it("ignores id, createdAt and updatedAt in the input", async () => {
    const forgedId = "00000000-0000-4000-8000-000000000000";
    const forgedDate = new Date("2000-01-01T00:00:00Z");
    const input = { ...mario, id: forgedId, createdAt: forgedDate, updatedAt: forgedDate } as CreateUserInput;

    const user = await scope(tenantA).users.create(input);

    expect(user.id).not.toBe(forgedId);
    expect(user.createdAt.getTime()).not.toBe(forgedDate.getTime());
    expect(user.updatedAt.getTime()).not.toBe(forgedDate.getTime());
  });

  it.each([
    ["upper case", "MARIO@ACME.IT"],
    ["mixed case", "Mario@Acme.It"],
    ["blanks at the edges", "  mario@acme.it "],
    ["blanks and upper case", "\tMARIO@acme.it "],
  ])("rejects a duplicate email in the same tenant (%s) with DuplicateEmailError", async (_label, email) => {
    await scope(tenantA).users.create(mario);

    const error = await expectError(scope(tenantA).users.create({ ...luigi, email }), DuplicateEmailError);
    expect(error.email).toBe(email.trim());
    expect(await countUsers(tenantA)).toBe(1);
  });

  it("accepts the same email in another tenant", async () => {
    await scope(tenantA).users.create(mario);
    const inB = await scope(tenantB).users.create({ ...mario, email: "MARIO@ACME.IT" });

    expect(inB.tenantId).toBe(tenantB);
    expect(await countUsers(tenantA)).toBe(1);
    expect(await countUsers(tenantB)).toBe(1);
  });

  it("lets only one of two concurrent creates with the same email succeed", async () => {
    // A pool with two connections, so that the inserts really race in the database.
    const client = postgres(requireTestDatabaseUrl(), { max: 2, onnotice: () => {} });
    try {
      const users = forTenant(tenantA, drizzle(client, { schema }) as unknown as Database).users;
      const results = await Promise.allSettled([users.create(mario), users.create({ ...luigi, email: "MARIO@acme.it" })]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(DuplicateEmailError);
      expect(await countUsers(tenantA)).toBe(1);
    } finally {
      await client.end();
    }
  });

  it.each<[string, Partial<Record<keyof CreateUserInput, unknown>>, string]>([
    ["an invalid email", { email: "mario" }, "email"],
    ["an email without a domain", { email: "mario@" }, "email"],
    ["a blank email", { email: "   " }, "email"],
    ["an email with a control character", { email: "mario\u0000@acme.it" }, "email"],
    ["an empty first name", { firstName: "" }, "firstName"],
    ["a blank first name", { firstName: " ​ " }, "firstName"],
    ["an empty last name", { lastName: "" }, "lastName"],
    ["a last name with a line break", { lastName: "Ros\nsi" }, "lastName"],
    ["a role outside OWNER, ADMIN, USER", { role: "SUPERUSER" }, "role"],
    ["a lower-case role", { role: "owner" }, "role"],
    ["an unknown status", { status: "DELETED" }, "status"],
    ["a missing email", { email: undefined }, "email"],
    ["a missing role", { role: undefined }, "role"],
  ])("rejects %s with ValidationError and inserts nothing", async (_label, override, field) => {
    const input = { ...mario, ...override } as CreateUserInput;
    const error = await expectError(scope(tenantA).users.create(input), ValidationError);
    expect(error.fields).toEqual([field]);
    expect(await countUsers()).toBe(0);
  });

  it.each([null, undefined, "mario@acme.it", 42, []])("rejects the non-object input %j", async (input) => {
    await expectError(scope(tenantA).users.create(input as unknown as CreateUserInput), ValidationError);
    expect(await countUsers()).toBe(0);
  });

  it("throws TenantNotFoundError for a tenant UUID that does not exist and inserts nothing", async () => {
    const error = await expectError(scope(UNKNOWN_UUID).users.create(mario), TenantNotFoundError);
    expect(error.tenantId).toBe(UNKNOWN_UUID);
    expect(await countUsers()).toBe(0);
  });

  it.each(["SUSPENDED", "CLOSED"] as const)("still works for a %s tenant", async (status) => {
    await setTenantStatus(tenantA, status, testDb());
    const users = scope(tenantA).users;

    const user = await users.create(mario);
    expect(await users.list()).toHaveLength(1);
    expect(await users.findById(user.id)).not.toBeNull();
    expect(await users.update(user.id, { role: "ADMIN" })).toMatchObject({ role: "ADMIN" });
    expect(await users.delete(user.id)).toBe(true);
  });
});

describe("tenant isolation with an ID of tenant B", () => {
  let userOfB: Awaited<ReturnType<ReturnType<typeof scope>["users"]["create"]>>;

  beforeEach(async () => {
    await scope(tenantA).users.create(mario);
    userOfB = await scope(tenantB).users.create(luigi);
  });

  it("list() of A returns only the users of A", async () => {
    await scope(tenantA).users.create({ ...luigi, email: "anna@acme.it" });
    await scope(tenantB).users.create({ ...mario, email: "mario@beta.it" });

    const listed = await scope(tenantA).users.list();
    expect(listed).toHaveLength(2);
    expect(listed.every((u) => u.tenantId === tenantA)).toBe(true);
    expect(listed.map((u) => u.email).sort()).toEqual(["anna@acme.it", "mario@acme.it"]);
  });

  it("findById returns null", async () => {
    expect(await scope(tenantA).users.findById(userOfB.id)).toBeNull();
    expect(await scope(tenantB).users.findById(userOfB.id)).toMatchObject({ id: userOfB.id });
  });

  it("update returns null and leaves the user unchanged, updated_at included", async () => {
    const before = await allUsers();
    const updatedBefore = await updatedAtMicros(userOfB.id);

    expect(await scope(tenantA).users.update(userOfB.id, { firstName: "X" })).toBeNull();
    expect(await scope(tenantA).users.update(userOfB.id, { email: "x@acme.it", role: "OWNER", status: "DISABLED" })).toBeNull();

    expect(await allUsers()).toEqual(before);
    expect(await updatedAtMicros(userOfB.id)).toBe(updatedBefore);
  });

  it("update with the email of a user of A still returns null (no duplicate leak)", async () => {
    const before = await allUsers();
    expect(await scope(tenantA).users.update(userOfB.id, { email: "MARIO@ACME.IT" })).toBeNull();
    expect(await allUsers()).toEqual(before);
  });

  it("delete returns false and the user still exists", async () => {
    const before = await allUsers();
    expect(await scope(tenantA).users.delete(userOfB.id)).toBe(false);
    expect(await allUsers()).toEqual(before);
  });
});

describe("users.findById", () => {
  it("returns the user of the tenant", async () => {
    const user = await scope(tenantA).users.create(mario);
    expect(await scope(tenantA).users.findById(user.id)).toEqual(user);
  });

  it("returns null for an unknown UUID", async () => {
    expect(await scope(tenantA).users.findById(UNKNOWN_UUID)).toBeNull();
  });

  it.each(NON_UUID_IDS)("returns null for the non-UUID id %j", async (id) => {
    await scope(tenantA).users.create(mario);
    expect(await scope(tenantA).users.findById(id)).toBeNull();
  });
});

describe("users.update", () => {
  it.each<[string, UpdateUserInput]>([
    ["first name", { firstName: "Mariano" }],
    ["last name", { lastName: "Bianchi" }],
    ["role", { role: "USER" }],
    ["status", { status: "DISABLED" }],
    ["email", { email: "m.rossi@acme.it" }],
    ["several fields", { firstName: "Mariano", role: "ADMIN", status: "ACTIVE" }],
  ])("saves a new %s and moves updated_at forward", async (_label, patch) => {
    const user = await scope(tenantA).users.create(mario);
    const updatedBefore = await updatedAtMicros(user.id);

    const updated = await scope(tenantA).users.update(user.id, patch);

    expect(updated).toMatchObject({ ...patch, id: user.id, tenantId: tenantA, createdAt: user.createdAt });
    expect(await scope(tenantA).users.findById(user.id)).toEqual(updated);
    expect((await updatedAtMicros(user.id)) > updatedBefore).toBe(true);
  });

  it("strictly increases updated_at on back-to-back updates", async () => {
    const user = await scope(tenantA).users.create(mario);
    const values = [await updatedAtMicros(user.id)];
    for (let i = 0; i < 5; i++) {
      await scope(tenantA).users.update(user.id, { role: "ADMIN" });
      values.push(await updatedAtMicros(user.id));
    }
    for (let i = 1; i < values.length; i++) expect(values[i] > values[i - 1]).toBe(true);
  });

  it("trims and validates the patch like create", async () => {
    const user = await scope(tenantA).users.create(mario);
    expect(await scope(tenantA).users.update(user.id, { firstName: "  Mariano " })).toMatchObject({
      firstName: "Mariano",
    });
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["an invalid email", { email: "not-an-email" }, "email"],
    ["a blank first name", { firstName: "  " }, "firstName"],
    ["an empty last name", { lastName: "" }, "lastName"],
    ["an unknown role", { role: "ROOT" }, "role"],
    ["an unknown status", { status: "DELETED" }, "status"],
  ])("rejects %s with ValidationError and changes nothing", async (_label, patch, field) => {
    const user = await scope(tenantA).users.create(mario);
    const before = await allUsers();
    const error = await expectError(scope(tenantA).users.update(user.id, patch as UpdateUserInput), ValidationError);
    expect(error.fields).toEqual([field]);
    expect(await allUsers()).toEqual(before);
  });

  it("rejects an empty patch with ValidationError and changes nothing (updated_at included)", async () => {
    const user = await scope(tenantA).users.create(mario);
    const before = await allUsers();
    await expectError(scope(tenantA).users.update(user.id, {}), ValidationError);
    await expectError(scope(tenantA).users.update(user.id, { firstName: undefined }), ValidationError);
    expect(await allUsers()).toEqual(before);
  });

  it.each(["tenantId", "tenant_id"])("never moves the user to another tenant via %s", async (key) => {
    const user = await scope(tenantA).users.create(mario);

    // Alone, the forged field leaves an empty patch: rejected.
    await expectError(scope(tenantA).users.update(user.id, { [key]: tenantB } as UpdateUserInput), ValidationError);
    // With a real change, the forged field is ignored.
    const updated = await scope(tenantA).users.update(user.id, { firstName: "Mariano", [key]: tenantB } as UpdateUserInput);

    expect(updated).toMatchObject({ tenantId: tenantA, firstName: "Mariano" });
    const [row] = await testSql()`select tenant_id from users where id = ${user.id}`;
    expect(row.tenant_id).toBe(tenantA);
    expect(await countUsers(tenantB)).toBe(0);
  });

  it("ignores id, createdAt and updatedAt in the patch", async () => {
    const user = await scope(tenantA).users.create(mario);
    const forgedDate = new Date("2000-01-01T00:00:00Z");
    const updated = await scope(tenantA).users.update(user.id, {
      firstName: "Mariano",
      id: UNKNOWN_UUID,
      createdAt: forgedDate,
      updatedAt: forgedDate,
    } as UpdateUserInput);

    expect(updated).toMatchObject({ id: user.id, createdAt: user.createdAt });
    expect(updated?.updatedAt.getTime()).not.toBe(forgedDate.getTime());
  });

  it.each(["luigi@acme.it", "LUIGI@ACME.IT", " Luigi@Acme.it "])(
    "throws DuplicateEmailError when changing the email to %j, already used in the tenant",
    async (email) => {
      const user = await scope(tenantA).users.create(mario);
      await scope(tenantA).users.create(luigi);
      const before = await allUsers();

      const error = await expectError(scope(tenantA).users.update(user.id, { email }), DuplicateEmailError);
      expect(error.email).toBe(email.trim());
      expect(await allUsers()).toEqual(before);
    },
  );

  it("accepts changing the case of the user's own email", async () => {
    const user = await scope(tenantA).users.create(mario);
    expect(await scope(tenantA).users.update(user.id, { email: "Mario@Acme.it" })).toMatchObject({
      email: "Mario@Acme.it",
    });
  });

  it("accepts an email already used in another tenant", async () => {
    await scope(tenantB).users.create(luigi);
    const user = await scope(tenantA).users.create(mario);
    expect(await scope(tenantA).users.update(user.id, { email: "luigi@acme.it" })).toMatchObject({
      email: "luigi@acme.it",
    });
  });

  it("returns null for an unknown UUID", async () => {
    expect(await scope(tenantA).users.update(UNKNOWN_UUID, { firstName: "X" })).toBeNull();
  });

  it.each(NON_UUID_IDS)("returns null for the non-UUID id %j", async (id) => {
    await scope(tenantA).users.create(mario);
    const before = await allUsers();
    expect(await scope(tenantA).users.update(id, { firstName: "X" })).toBeNull();
    expect(await allUsers()).toEqual(before);
  });
});

describe("users.delete", () => {
  it("deletes the user of A and leaves the users of B unchanged", async () => {
    const user = await scope(tenantA).users.create(mario);
    const other = await scope(tenantA).users.create(luigi);
    await scope(tenantB).users.create(mario);
    await scope(tenantB).users.create(luigi);
    const usersOfB = await testSql()`select * from users where tenant_id = ${tenantB} order by id`;

    expect(await scope(tenantA).users.delete(user.id)).toBe(true);

    expect(await scope(tenantA).users.findById(user.id)).toBeNull();
    expect((await scope(tenantA).users.list()).map((u) => u.id)).toEqual([other.id]);
    expect(await testSql()`select * from users where tenant_id = ${tenantB} order by id`).toEqual(usersOfB);
  });

  it("returns false the second time", async () => {
    const user = await scope(tenantA).users.create(mario);
    expect(await scope(tenantA).users.delete(user.id)).toBe(true);
    expect(await scope(tenantA).users.delete(user.id)).toBe(false);
  });

  it("returns false for an unknown UUID", async () => {
    expect(await scope(tenantA).users.delete(UNKNOWN_UUID)).toBe(false);
  });

  it.each(NON_UUID_IDS)("returns false for the non-UUID id %j", async (id) => {
    await scope(tenantA).users.create(mario);
    expect(await scope(tenantA).users.delete(id)).toBe(false);
    expect(await countUsers()).toBe(1);
  });
});

describe("users.list", () => {
  it("returns an empty list for a tenant without users", async () => {
    await scope(tenantB).users.create(mario);
    expect(await scope(tenantA).users.list()).toEqual([]);
  });

  it("returns an empty list for a tenant UUID that does not exist", async () => {
    await scope(tenantA).users.create(mario);
    expect(await scope(UNKNOWN_UUID).users.list()).toEqual([]);
  });

  it("returns the users oldest first", async () => {
    const first = await scope(tenantA).users.create(mario);
    const second = await scope(tenantA).users.create(luigi);
    expect((await scope(tenantA).users.list()).map((u) => u.id)).toEqual([first.id, second.id]);
  });
});

// The "default database" test opens the application pool: close it.
afterAll(closeDb);
