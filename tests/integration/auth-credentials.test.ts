import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { beforeEach, describe, expect, it } from "vitest";

import { verifyCredentials } from "@/db/auth";
import { DuplicateLoginEmailError, ValidationError } from "@/db/errors";
import { requireTestDatabaseUrl } from "@/db/migrate";
import { createTenant, setTenantStatus } from "@/db/platform/tenants";
import * as schema from "@/db/schema";
import { forTenant, type CreateUserInput } from "@/db/tenant-scope";

import { testDb, testSql } from "../helpers/db";

const PASSWORD = "password-lunga-123";
const UNKNOWN_UUID = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

const mario: CreateUserInput = {
  email: "mario@acme.it",
  firstName: "Mario",
  lastName: "Rossi",
  role: "OWNER",
  status: "ACTIVE",
};

let tenantA: string;
let tenantB: string;

beforeEach(async () => {
  tenantA = (await createTenant({ businessName: "Acme S.r.l.", vatNumber: "12345678903" }, testDb())).id;
  tenantB = (await createTenant({ businessName: "Beta S.r.l.", taxCode: "RSSMRA80A01H501U" }, testDb())).id;
});

const scope = (tenantId: string) => forTenant(tenantId, testDb());
const login = (email: string, password: string) => verifyCredentials(email, password, testDb());

async function hashOf(id: string): Promise<string | null> {
  const [row] = await testSql()`select password_hash from users where id = ${id}`;
  return row.password_hash;
}

async function userWithPassword(input: CreateUserInput = mario, tenantId = tenantA) {
  const user = await scope(tenantId).users.create(input);
  expect(await scope(tenantId).users.setPassword(user.id, PASSWORD)).toBe(true);
  return user;
}

describe("users.setPassword", () => {
  it("stores an argon2id hash and never the plain password", async () => {
    const user = await scope(tenantA).users.create(mario);
    expect(await hashOf(user.id)).toBeNull();
    expect(await scope(tenantA).users.setPassword(user.id, PASSWORD)).toBe(true);
    const hash = await hashOf(user.id);
    expect(hash?.startsWith("$argon2id$")).toBe(true);
    expect(hash).not.toContain(PASSWORD);
  });

  it("returns false for a user of another tenant and leaves its hash unchanged", async () => {
    const userB = await userWithPassword(mario, tenantB);
    const before = await hashOf(userB.id);
    expect(await scope(tenantA).users.setPassword(userB.id, "un-altra-password-1")).toBe(false);
    expect(await hashOf(userB.id)).toBe(before);
  });

  it.each(["not-a-uuid", "", UNKNOWN_UUID, "' or 1=1 --"])("returns false for the id %j", async (id) => {
    expect(await scope(tenantA).users.setPassword(id, PASSWORD)).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["11 characters", "a".repeat(11)],
    ["1025 characters", "a".repeat(1025)],
  ])("rejects a password that is %s with ValidationError and changes nothing", async (_label, password) => {
    const user = await scope(tenantA).users.create(mario);
    await scope(tenantA).users.setPassword(user.id, PASSWORD);
    const before = await hashOf(user.id);
    await expect(scope(tenantA).users.setPassword(user.id, password)).rejects.toBeInstanceOf(ValidationError);
    expect(await hashOf(user.id)).toBe(before);
  });

  it.each([12, 1024])("accepts a password of %i characters", async (length) => {
    const user = await scope(tenantA).users.create(mario);
    expect(await scope(tenantA).users.setPassword(user.id, "x".repeat(length))).toBe(true);
  });

  it("accepts Unicode passwords as they are, without normalisation", async () => {
    const user = await scope(tenantA).users.create(mario);
    const composed = "paèsword-lunga-123";
    await scope(tenantA).users.setPassword(user.id, composed);
    await testSql()`update users set status = 'ACTIVE' where id = ${user.id}`;
    expect(await login(mario.email, composed)).not.toBeNull();
    expect(await login(mario.email, "paèsword-lunga-123")).toBeNull();
  });

  it("does not expose the hash through the users operations", async () => {
    const user = await userWithPassword();
    expect(await scope(tenantA).users.findById(user.id)).not.toHaveProperty("passwordHash");
    expect((await scope(tenantA).users.list())[0]).not.toHaveProperty("passwordHash");
  });

  it("throws DuplicateLoginEmailError for the same email, in any case, in another tenant", async () => {
    await userWithPassword();
    const other = await scope(tenantB).users.create({ ...mario, email: "MARIO@Acme.it" });
    await expect(scope(tenantB).users.setPassword(other.id, PASSWORD)).rejects.toBeInstanceOf(
      DuplicateLoginEmailError,
    );
    expect(await hashOf(other.id)).toBeNull();
  });

  it("lets users without a password share the email across tenants", async () => {
    await scope(tenantA).users.create(mario);
    await expect(scope(tenantB).users.create(mario)).resolves.toBeDefined();
  });

  it("refuses to change an email into one that already logs in elsewhere", async () => {
    await userWithPassword();
    const other = await scope(tenantB).users.create({ ...mario, email: "luigi@beta.it" });
    await scope(tenantB).users.setPassword(other.id, PASSWORD);
    await expect(scope(tenantB).users.update(other.id, { email: "Mario@acme.it" })).rejects.toBeInstanceOf(
      DuplicateLoginEmailError,
    );
  });

  it("with two concurrent calls on the same email in different tenants, one succeeds and one fails", async () => {
    const a = await scope(tenantA).users.create(mario);
    const b = await scope(tenantB).users.create(mario);
    const clients = [postgres(requireTestDatabaseUrl(), { max: 1 }), postgres(requireTestDatabaseUrl(), { max: 1 })];
    try {
      const [dbA, dbB] = clients.map((client) => drizzle(client, { schema }));
      const results = await Promise.allSettled([
        forTenant(tenantA, dbA).users.setPassword(a.id, PASSWORD),
        forTenant(tenantB, dbB).users.setPassword(b.id, PASSWORD),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(DuplicateLoginEmailError);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  });
});

describe("verifyCredentials", () => {
  it("returns user and tenantId for an email with different case and spaces", async () => {
    const user = await userWithPassword();
    expect(await login("  MARIO@Acme.IT ", PASSWORD)).toEqual({
      user: { id: user.id, email: "mario@acme.it", firstName: "Mario", lastName: "Rossi", role: "OWNER" },
      tenantId: tenantA,
    });
  });

  it("returns the tenant of the user, whichever tenant has other users", async () => {
    await userWithPassword();
    const luigi = await userWithPassword({ ...mario, email: "luigi@beta.it", firstName: "Luigi" }, tenantB);
    expect(await login("luigi@beta.it", PASSWORD)).toMatchObject({ user: { id: luigi.id }, tenantId: tenantB });
  });

  it("returns null for a wrong password", async () => {
    await userWithPassword();
    expect(await login(mario.email, "password-sbagliata-1")).toBeNull();
    expect(await login(mario.email, "")).toBeNull();
    expect(await login(mario.email, "x".repeat(100_000))).toBeNull();
  });

  it("returns null for an unknown email and for a blank one", async () => {
    await userWithPassword();
    expect(await login("nessuno@acme.it", PASSWORD)).toBeNull();
    expect(await login("", PASSWORD)).toBeNull();
    expect(await login("   ", PASSWORD)).toBeNull();
    expect(await login("%", PASSWORD)).toBeNull();
  });

  it("returns null for a user without a password", async () => {
    await scope(tenantA).users.create(mario);
    expect(await login(mario.email, PASSWORD)).toBeNull();
  });

  it.each(["INVITED", "DISABLED"])("returns null for a %s user", async (status) => {
    const user = await userWithPassword();
    await testSql()`update users set status = ${status}::user_status where id = ${user.id}`;
    expect(await login(mario.email, PASSWORD)).toBeNull();
  });

  it.each(["SUSPENDED", "CLOSED"] as const)("returns null for a %s tenant", async (status) => {
    await userWithPassword();
    await setTenantStatus(tenantA, status, testDb());
    expect(await login(mario.email, PASSWORD)).toBeNull();
  });

  it("does not distinguish the failure cases: all of them are plain null", async () => {
    await userWithPassword();
    const results = await Promise.all([
      login(mario.email, "password-sbagliata-1"),
      login("nessuno@acme.it", PASSWORD),
    ]);
    expect(results).toEqual([null, null]);
  });
});
