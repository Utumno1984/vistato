import { describe, expect, it, vi } from "vitest";

import { verifyCredentials } from "@/db/auth";

import { testDb } from "../helpers/db";

const verifySpy = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/password", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/password")>();
  return {
    ...actual,
    verifyPassword: (hash: string, password: string) => {
      verifySpy(hash, password);
      return actual.verifyPassword(hash, password);
    },
  };
});

describe("verifyCredentials with an unknown email", () => {
  it("still verifies the password against a dummy argon2id hash", async () => {
    verifySpy.mockClear();
    expect(await verifyCredentials("nessuno@acme.it", "password-lunga-123", testDb())).toBeNull();
    expect(verifySpy).toHaveBeenCalledTimes(1);
    expect(verifySpy.mock.calls[0][0]).toMatch(/^\$argon2id\$/);
    expect(verifySpy.mock.calls[0][1]).toBe("password-lunga-123");
  });
});
