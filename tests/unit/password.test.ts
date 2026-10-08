import { describe, expect, it } from "vitest";

import { hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, verifyPassword } from "@/lib/auth/password";

describe("password hashing", () => {
  it("produces an argon2id hash with the OWASP parameters, without the plain password", async () => {
    const hash = await hashPassword("password-lunga-123");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).toContain("m=19456,t=2,p=1");
    expect(hash).not.toContain("password-lunga-123");
  });

  it("salts every hash: the same password hashes differently", async () => {
    expect(await hashPassword("password-lunga-123")).not.toBe(await hashPassword("password-lunga-123"));
  });

  it("verifies the right password and rejects a wrong one", async () => {
    const hash = await hashPassword("password-lunga-123");
    expect(await verifyPassword(hash, "password-lunga-123")).toBe(true);
    expect(await verifyPassword(hash, "password-lunga-124")).toBe(false);
    expect(await verifyPassword(hash, "")).toBe(false);
  });

  it("does not normalise Unicode: composed and decomposed forms are different passwords", async () => {
    const composed = "paèsword-lunga-123"; // è as one code point
    const decomposed = "paèsword-lunga-123"; // e + combining grave
    const hash = await hashPassword(composed);
    expect(await verifyPassword(hash, composed)).toBe(true);
    expect(await verifyPassword(hash, decomposed)).toBe(false);
  });

  it("treats a malformed hash as a mismatch instead of throwing", async () => {
    expect(await verifyPassword("not-a-hash", "password-lunga-123")).toBe(false);
    expect(await verifyPassword("", "password-lunga-123")).toBe(false);
  });

  it("exposes the length bounds 12 and 1024", () => {
    expect([PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH]).toEqual([12, 1024]);
  });
});
