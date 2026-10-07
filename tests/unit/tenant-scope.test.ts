import { describe, expect, it } from "vitest";

import type { Database } from "@/db/client";
import { ValidationError } from "@/db/errors";
import { forTenant, type CreateUserInput, type UpdateUserInput } from "@/db/tenant-scope";

/** A database that fails the test as soon as anything touches it. */
const untouchableDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`The database was used (${String(property)})`);
    },
  },
) as Database;

const TENANT = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const NON_UUIDS = ["not-a-uuid", "", "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5", "' or 1=1 --", `${TENANT}\u0000`];

const users = () => forTenant(TENANT, untouchableDb).users;

describe("forTenant without a database round trip", () => {
  it.each(NON_UUIDS)("rejects the tenant id %j with ValidationError", (tenantId) => {
    expect(() => forTenant(tenantId, untouchableDb)).toThrow(ValidationError);
  });

  it("rejects a non-UUID tenant id before resolving the default database", () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => forTenant("not-a-uuid")).toThrow(ValidationError);
    } finally {
      process.env.DATABASE_URL = original;
    }
  });

  it.each(NON_UUIDS)("treats the user id %j as not found without querying", async (id) => {
    expect(await users().findById(id)).toBeNull();
    expect(await users().update(id, { firstName: "X" })).toBeNull();
    expect(await users().delete(id)).toBe(false);
  });

  it("rejects an invalid create input without querying", async () => {
    const input = { email: "mario", firstName: "", lastName: "Rossi", role: "ROOT" } as unknown as CreateUserInput;
    const error = await users().create(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).fields.sort()).toEqual(["email", "firstName", "role"]);
  });

  it.each<[string, unknown]>([
    ["an empty patch", {}],
    ["a patch with only undefined values", { firstName: undefined }],
    ["a patch with only a tenant id", { tenantId: TENANT }],
    ["a patch with only unknown fields", { id: TENANT, createdAt: new Date() }],
    ["an invalid patch", { role: "ROOT" }],
    ["a non-object patch", null],
  ])("rejects %s without querying", async (_label, patch) => {
    await expect(users().update(TENANT, patch as UpdateUserInput)).rejects.toBeInstanceOf(ValidationError);
  });
});
