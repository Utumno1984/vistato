import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { createSession, deleteSession, resolveSession, SESSION_DURATION_MS } from "@/db/auth";
import { createTenant, setTenantStatus } from "@/db/platform/tenants";
import { forTenant } from "@/db/tenant-scope";

import { testDb, testSql } from "../helpers/db";

let tenantA: string;
let tenantB: string;
let userA: string;
let userB: string;

beforeEach(async () => {
  tenantA = (await createTenant({ businessName: "Acme S.r.l.", vatNumber: "12345678903" }, testDb())).id;
  tenantB = (await createTenant({ businessName: "Beta S.r.l.", taxCode: "RSSMRA80A01H501U" }, testDb())).id;
  const person = { email: "mario@acme.it", firstName: "Mario", lastName: "Rossi", role: "OWNER", status: "ACTIVE" } as const;
  userA = (await forTenant(tenantA, testDb()).users.create(person)).id;
  userB = (await forTenant(tenantB, testDb()).users.create(person)).id;
});

const create = (userId = userA, tenantId = tenantA, now?: Date) => createSession(userId, tenantId, testDb(), now);
const resolve = (token: string, now?: Date) => resolveSession(token, testDb(), now);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

describe("createSession", () => {
  it("returns a random base64url token of at least 32 bytes and stores only its SHA-256", async () => {
    const token = await create();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, "base64url").length).toBeGreaterThanOrEqual(32);
    expect(await create()).not.toBe(token);

    const rows = await testSql()`select * from sessions where user_id = ${userA} and tenant_id = ${tenantA}`;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.token_hash)).toContain(sha256(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("expires 7 days after the reference instant", async () => {
    const now = new Date("2026-03-01T10:00:00.000Z");
    const token = await create(userA, tenantA, now);
    const [row] = await testSql()`select expires_at from sessions where token_hash = ${sha256(token)}`;
    expect(new Date(row.expires_at).getTime()).toBe(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    expect(SESSION_DURATION_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("is rejected by the database when the user belongs to another tenant", async () => {
    await expect(create(userA, tenantB)).rejects.toThrow();
    await expect(
      testSql()`insert into sessions (tenant_id, user_id, token_hash, expires_at)
        values (${tenantB}, ${userA}, 'x', now() + interval '1 day')`,
    ).rejects.toThrow(/sessions_user_id_tenant_id_users_fk/);
    const [{ count }] = await testSql()`select count(*)::int as count from sessions`;
    expect(count).toBe(0);
  });
});

describe("resolveSession", () => {
  it("returns session id, user and tenant", async () => {
    const token = await create();
    const [{ id }] = await testSql()`select id from sessions`;
    expect(await resolve(token)).toEqual({
      sessionId: id,
      user: { id: userA, email: "mario@acme.it", firstName: "Mario", lastName: "Rossi", role: "OWNER" },
      tenant: { id: tenantA, businessName: "Acme S.r.l." },
    });
  });

  it("returns the tenant of the session, not one of another tenant with the same email", async () => {
    const token = await create(userB, tenantB);
    expect((await resolve(token))?.tenant.id).toBe(tenantB);
  });

  it.each([
    ["empty", ""],
    ["malformed", "not a token!"],
    ["unknown but well-formed", "A".repeat(43)],
    ["with non-base64url characters", "+/=".repeat(15)],
    ["very long", "A".repeat(1_000_000)],
    ["with a NUL character", `${"A".repeat(42)}\u0000`],
  ])("returns null for a token that is %s", async (_label, token) => {
    await create();
    expect(await resolve(token)).toBeNull();
  });

  it("is valid one millisecond before expiry and expired exactly at expires_at", async () => {
    const now = new Date("2026-03-01T10:00:00.000Z");
    const token = await create(userA, tenantA, now);
    const expiry = now.getTime() + SESSION_DURATION_MS;
    expect(await resolve(token, new Date(expiry - 1))).not.toBeNull();
    expect(await resolve(token, new Date(expiry))).toBeNull();
    expect(await resolve(token, new Date(expiry + 1))).toBeNull();
  });

  it("returns null once the user is DISABLED or INVITED", async () => {
    const token = await create();
    expect(await resolve(token)).not.toBeNull();
    for (const status of ["DISABLED", "INVITED"]) {
      await testSql()`update users set status = ${status}::user_status where id = ${userA}`;
      expect(await resolve(token)).toBeNull();
    }
    await testSql()`update users set status = 'ACTIVE' where id = ${userA}`;
    expect(await resolve(token)).not.toBeNull();
  });

  it.each(["SUSPENDED", "CLOSED"] as const)("returns null once the tenant is %s", async (status) => {
    const token = await create();
    await setTenantStatus(tenantA, status, testDb());
    expect(await resolve(token)).toBeNull();
  });
});

describe("deleteSession", () => {
  it("removes the row, so the token no longer resolves, and can be repeated", async () => {
    const token = await create();
    const other = await create();
    await deleteSession(token, testDb());
    expect(await resolve(token)).toBeNull();
    expect(await resolve(other)).not.toBeNull();
    const rows = await testSql()`select 1 from sessions where token_hash = ${sha256(token)}`;
    expect(rows).toHaveLength(0);
    await expect(deleteSession(token, testDb())).resolves.toBeUndefined();
  });

  it("ignores empty, malformed and unknown tokens", async () => {
    for (const token of ["", "nope!", "A".repeat(43), "A".repeat(100_000)]) {
      await expect(deleteSession(token, testDb())).resolves.toBeUndefined();
    }
  });
});

describe("sessions and users", () => {
  it("are deleted with the user (ON DELETE CASCADE) and only with that user", async () => {
    const token = await create();
    const keep = await create(userB, tenantB);
    expect(await forTenant(tenantA, testDb()).users.delete(userA)).toBe(true);
    expect(await resolve(token)).toBeNull();
    const [{ count }] = await testSql()`select count(*)::int as count from sessions where user_id = ${userA}`;
    expect(count).toBe(0);
    expect(await resolve(keep)).not.toBeNull();
  });
});
