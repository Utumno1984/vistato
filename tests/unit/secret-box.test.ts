import * as nodeCrypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  decryptSecret,
  encryptSecret,
  SecretBoxConfigError,
  SecretBoxValidationError,
  SecretDecryptionError,
  type SecretContext,
} from "@/lib/crypto/secret-box";

// Wraps the primitives in spies (same behaviour) to prove that validation runs before them.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomBytes: vi.fn(actual.randomBytes),
    createCipheriv: vi.fn(actual.createCipheriv),
    createDecipheriv: vi.fn(actual.createDecipheriv),
    createHash: vi.fn(actual.createHash),
  };
});

const TENANT_A = "0b9f4f0e-6a43-4c1e-9d55-2f1a7c3e8b10";
const TENANT_B = "7d2c1a9e-3b4f-4e8a-a1c6-5e0f9b2d4c33";
const A_ACCESS: SecretContext = { tenantId: TENANT_A, purpose: "fic_access_token" };
const SECRET = "a.fic-access-token.0123456789abcdef";

const newKey = () => nodeCrypto.randomBytes(32).toString("base64");
const KEY_OLD = newKey();
const KEY_NEW = newKey();
const KEY_OTHER = newKey();

function setKeys(current: string | undefined, previous?: string) {
  vi.stubEnv("SECRETS_ENCRYPTION_KEY", current);
  vi.stubEnv("SECRETS_ENCRYPTION_KEY_PREVIOUS", previous);
}

/** Runs `fn`, expecting it to throw, and returns the error. */
function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a throw");
}

/** Every textual form of an error, to look for leaked data. */
function errorText(error: Error): string {
  return [error.message, error.stack, String(error), JSON.stringify(error), String((error as { cause?: unknown }).cause)].join("\n");
}

/** The five fields of a v1 value, with the binary ones decoded. */
function fields(value: string) {
  const [version, keyId, iv, tag, ciphertext] = value.split(":");
  return {
    version,
    keyId,
    iv: Buffer.from(iv, "base64"),
    tag: Buffer.from(tag, "base64"),
    ciphertext: Buffer.from(ciphertext, "base64"),
  };
}

const spies = {
  randomBytes: vi.mocked(nodeCrypto.randomBytes),
  createCipheriv: vi.mocked(nodeCrypto.createCipheriv),
  createDecipheriv: vi.mocked(nodeCrypto.createDecipheriv),
  createHash: vi.mocked(nodeCrypto.createHash),
};

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  setKeys(KEY_NEW);
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("secret box: round trip and format", () => {
  it("round-trips a secret for the same tenant and purpose", () => {
    const encrypted = encryptSecret(SECRET, A_ACCESS);
    expect(decryptSecret(encrypted, A_ACCESS)).toEqual({ plaintext: SECRET, needsReencryption: false });
  });

  it("round-trips a secret of 8 KB", () => {
    const long = "x".repeat(8 * 1024 - 3) + "end";
    expect(long).toHaveLength(8192);
    expect(decryptSecret(encryptSecret(long, A_ACCESS), A_ACCESS).plaintext).toBe(long);
  });

  it("round-trips a secret with non-ASCII Unicode characters", () => {
    const unicode = "tökèn-€-日本語-😀-́é";
    expect(decryptSecret(encryptSecret(unicode, A_ACCESS), A_ACCESS).plaintext).toBe(unicode);
  });

  it("accepts the tenant UUID in any letter case", () => {
    const encrypted = encryptSecret(SECRET, { ...A_ACCESS, tenantId: TENANT_A.toUpperCase() });
    expect(decryptSecret(encrypted, A_ACCESS).plaintext).toBe(SECRET);
  });

  it("refuses an empty secret with a validation error", () => {
    const error = thrown(() => encryptSecret("", A_ACCESS));
    expect(error).toBeInstanceOf(SecretBoxValidationError);
    expect(error.message).toBe("The secret must be a non-empty string");
    expect(thrown(() => encryptSecret(undefined as unknown as string, A_ACCESS))).toBeInstanceOf(
      SecretBoxValidationError,
    );
  });

  it("refuses a secret with a lone surrogate instead of corrupting it", () => {
    expect(thrown(() => encryptSecret("abc\ud800def", A_ACCESS))).toBeInstanceOf(SecretBoxValidationError);
  });

  it("produces a different value each time, with a random 12-byte IV, never containing the secret", () => {
    const first = encryptSecret(SECRET, A_ACCESS);
    const second = encryptSecret(SECRET, A_ACCESS);
    expect(first).not.toBe(second);
    for (const value of [first, second]) {
      expect(value).toMatch(/^v1:[0-9a-f]{16}:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
      expect(value).not.toContain(SECRET);
      expect(value).not.toContain(Buffer.from(SECRET).toString("base64").slice(0, 16));
      const { iv, tag, ciphertext } = fields(value);
      expect(iv).toHaveLength(12);
      expect(tag).toHaveLength(16);
      expect(ciphertext.includes(Buffer.from(SECRET))).toBe(false);
    }
    expect(fields(first).iv.equals(fields(second).iv)).toBe(false);
  });

  it("is standard AES-256-GCM with the version, tenant and purpose as AAD", () => {
    const { iv, tag, ciphertext } = fields(encryptSecret(SECRET, A_ACCESS));
    const decipher = nodeCrypto.createDecipheriv("aes-256-gcm", Buffer.from(KEY_NEW, "base64"), iv);
    decipher.setAAD(Buffer.from(`vistato-secret-box\0v1\0${TENANT_A}\0fic_access_token`));
    decipher.setAuthTag(tag);
    expect(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")).toBe(SECRET);
  });

  it("is marked server-only", () => {
    const source = readFileSync(join(import.meta.dirname, "../../src/lib/crypto/secret-box.ts"), "utf8");
    expect(source.startsWith('import "server-only";')).toBe(true);
  });
});

describe("secret box: binding to tenant and purpose, tampering", () => {
  it("throws SecretDecryptionError for another tenant, without data", () => {
    const encrypted = encryptSecret(SECRET, A_ACCESS);
    const error = thrown(() => decryptSecret(encrypted, { ...A_ACCESS, tenantId: TENANT_B }));
    expect(error).toBeInstanceOf(SecretDecryptionError);
    expect(errorText(error)).not.toContain(SECRET);
  });

  it("throws SecretDecryptionError for another purpose", () => {
    const encrypted = encryptSecret(SECRET, A_ACCESS);
    expect(thrown(() => decryptSecret(encrypted, { ...A_ACCESS, purpose: "fic_refresh_token" }))).toBeInstanceOf(
      SecretDecryptionError,
    );
  });

  it("throws SecretDecryptionError when any single byte of IV, tag or ciphertext is altered", () => {
    const encrypted = encryptSecret(SECRET, A_ACCESS);
    const parts = encrypted.split(":");
    let attempts = 0;
    for (const index of [2, 3, 4]) {
      const bytes = Buffer.from(parts[index], "base64");
      for (let i = 0; i < bytes.length; i++) {
        const altered = Buffer.from(bytes);
        altered[i] ^= 0x01;
        const copy = [...parts];
        copy[index] = altered.toString("base64");
        expect(thrown(() => decryptSecret(copy.join(":"), A_ACCESS))).toBeInstanceOf(SecretDecryptionError);
        attempts++;
      }
    }
    expect(attempts).toBe(12 + 16 + Buffer.byteLength(SECRET));
  });

  it("throws SecretDecryptionError for unknown formats: truncated, extra field, unknown version, bad fields", () => {
    const encrypted = encryptSecret(SECRET, A_ACCESS);
    const [, keyId, iv, tag, ciphertext] = encrypted.split(":");
    const malformed = [
      "",
      "garbage",
      encrypted.slice(0, -4),
      encrypted.slice(0, encrypted.lastIndexOf(":")),
      `${encrypted}:extra`,
      `${encrypted}:`,
      `v2:${keyId}:${iv}:${tag}:${ciphertext}`,
      `V1:${keyId}:${iv}:${tag}:${ciphertext}`,
      `v1:${keyId.slice(1)}:${iv}:${tag}:${ciphertext}`,
      `v1:${keyId}:${iv.slice(0, -4)}:${tag}:${ciphertext}`,
      `v1:${keyId}:${iv}:${tag.slice(0, -4)}:${ciphertext}`,
      `v1:${keyId}:${iv}:${tag}:`,
      `v1:${keyId}:${iv} :${tag}:${ciphertext}`,
      `v1:${keyId}:${iv}:${tag}:${ciphertext}!`,
      `v1:${keyId}:${iv}:${tag.replace(/=+$/, "")}:${ciphertext}`,
      ` ${encrypted}`,
      `${encrypted}\n`,
    ];
    for (const value of malformed) {
      expect(thrown(() => decryptSecret(value, A_ACCESS)), JSON.stringify(value)).toBeInstanceOf(
        SecretDecryptionError,
      );
    }
    expect(thrown(() => decryptSecret(42 as unknown as string, A_ACCESS))).toBeInstanceOf(SecretDecryptionError);
  });
});

describe("secret box: key configuration", () => {
  const raw = (length: number) => nodeCrypto.randomBytes(length).toString("base64");
  const badKeys: [string, string | undefined][] = [
    ["missing", undefined],
    ["empty", ""],
    ["not base64", "this is not base64 at all!!"],
    ["31 bytes", raw(31)],
    ["33 bytes", raw(33)],
    ["spaces around", ` ${KEY_NEW} `],
    ["trailing newline", `${KEY_NEW}\n`],
    ["base64url alphabet", Buffer.alloc(32, 0xfb).toString("base64url")],
  ];

  it("throws a clear config error without the key value when SECRETS_ENCRYPTION_KEY is missing, empty, not base64 or not 32 bytes", () => {
    const encrypted = encryptSecret(SECRET, A_ACCESS);
    for (const [label, value] of badKeys) {
      setKeys(value);
      for (const call of [() => encryptSecret(SECRET, A_ACCESS), () => decryptSecret(encrypted, A_ACCESS)]) {
        const error = thrown(call);
        expect(error, label).toBeInstanceOf(SecretBoxConfigError);
        expect(error.message, label).toContain("SECRETS_ENCRYPTION_KEY");
        expect(error.message, label).toContain("openssl rand -base64 32");
        if (value) {
          expect(errorText(error), label).not.toContain(value.trim());
          expect(errorText(error), label).not.toContain(value.trim().slice(0, 12));
        }
        expect(errorText(error), label).not.toContain(SECRET);
        expect(errorText(error), label).not.toContain(encrypted);
      }
    }
  });

  it("names the length problem for 31 and 33 bytes and the format problem for spaces around", () => {
    setKeys(raw(31));
    expect(thrown(() => encryptSecret(SECRET, A_ACCESS)).message).toContain("32 bytes, not 31");
    setKeys(raw(33));
    expect(thrown(() => encryptSecret(SECRET, A_ACCESS)).message).toContain("32 bytes, not 33");
    setKeys(` ${KEY_NEW} `);
    expect(thrown(() => encryptSecret(SECRET, A_ACCESS)).message).toContain("not valid base64");
  });

  it("rejects a malformed SECRETS_ENCRYPTION_KEY_PREVIOUS and ignores an empty one", () => {
    const encrypted = encryptSecret(SECRET, A_ACCESS);
    const badPrevious = raw(31);
    setKeys(KEY_NEW, badPrevious);
    const error = thrown(() => decryptSecret(encrypted, A_ACCESS));
    expect(error).toBeInstanceOf(SecretBoxConfigError);
    expect(error.message).toContain("SECRETS_ENCRYPTION_KEY_PREVIOUS");
    expect(errorText(error)).not.toContain(badPrevious);
    setKeys(KEY_NEW, "");
    expect(decryptSecret(encrypted, A_ACCESS).plaintext).toBe(SECRET);
  });

  it("does not need the key to import the module", async () => {
    setKeys(undefined);
    vi.resetModules();
    const fresh = await import("@/lib/crypto/secret-box");
    expect(typeof fresh.encryptSecret).toBe("function");
  });
});

describe("secret box: key rotation", () => {
  it("decrypts a value of the previous key after a rotation and flags it for re-encryption", () => {
    setKeys(KEY_OLD);
    const oldValue = encryptSecret(SECRET, A_ACCESS);
    setKeys(KEY_NEW, KEY_OLD);
    expect(decryptSecret(oldValue, A_ACCESS)).toEqual({ plaintext: SECRET, needsReencryption: true });
  });

  it("always encrypts with the current key after a rotation", () => {
    setKeys(KEY_OLD);
    const oldKeyId = fields(encryptSecret(SECRET, A_ACCESS)).keyId;
    setKeys(KEY_NEW, KEY_OLD);
    const reencrypted = encryptSecret(SECRET, A_ACCESS);
    expect(fields(reencrypted).keyId).not.toBe(oldKeyId);
    expect(decryptSecret(reencrypted, A_ACCESS).needsReencryption).toBe(false);
    setKeys(KEY_NEW);
    expect(decryptSecret(reencrypted, A_ACCESS)).toEqual({ plaintext: SECRET, needsReencryption: false });
    setKeys(KEY_OLD);
    expect(thrown(() => decryptSecret(reencrypted, A_ACCESS))).toBeInstanceOf(SecretDecryptionError);
  });

  it("treats SECRETS_ENCRYPTION_KEY_PREVIOUS equal to the current key as no previous key", () => {
    setKeys(KEY_NEW, KEY_NEW);
    const encrypted = encryptSecret(SECRET, A_ACCESS);
    expect(decryptSecret(encrypted, A_ACCESS)).toEqual({ plaintext: SECRET, needsReencryption: false });
  });

  it("throws SecretDecryptionError for a value of a key that is neither current nor previous", () => {
    setKeys(KEY_OTHER);
    const foreign = encryptSecret(SECRET, A_ACCESS);
    setKeys(KEY_NEW, KEY_OLD);
    expect(thrown(() => decryptSecret(foreign, A_ACCESS))).toBeInstanceOf(SecretDecryptionError);
  });

  it("throws SecretDecryptionError when the key ID is rewritten to the current key", () => {
    setKeys(KEY_OTHER);
    const foreign = encryptSecret(SECRET, A_ACCESS).split(":");
    setKeys(KEY_NEW);
    foreign[1] = fields(encryptSecret(SECRET, A_ACCESS)).keyId;
    expect(thrown(() => decryptSecret(foreign.join(":"), A_ACCESS))).toBeInstanceOf(SecretDecryptionError);
  });

  it("never exposes the key in the key ID", () => {
    const { keyId } = fields(encryptSecret(SECRET, A_ACCESS));
    expect(keyId).toHaveLength(16);
    expect(Buffer.from(KEY_NEW, "base64").toString("hex")).not.toContain(keyId);
    expect(KEY_NEW).not.toContain(keyId);
  });
});

describe("secret box: input validation", () => {
  const badTenants = ["not-a-uuid", "", "0b9f4f0e6a434c1e9d552f1a7c3e8b10", `${TENANT_A} `, "1", undefined, 42];
  const badPurposes = ["fic_id_token", "", "FIC_ACCESS_TOKEN", "fic_access_token ", undefined, "__proto__"];

  function resetSpies() {
    for (const spy of Object.values(spies)) spy.mockClear();
  }
  function expectNoCrypto() {
    for (const [name, spy] of Object.entries(spies)) expect(spy, name).not.toHaveBeenCalled();
  }

  it("throws a validation error for a non-UUID tenantId before any cryptographic operation", () => {
    const encrypted = encryptSecret(SECRET, A_ACCESS);
    for (const configured of [KEY_NEW, undefined]) {
      setKeys(configured);
      for (const tenantId of badTenants) {
        const context = { tenantId, purpose: "fic_access_token" } as unknown as SecretContext;
        resetSpies();
        const onEncrypt = thrown(() => encryptSecret(SECRET, context));
        const onDecrypt = thrown(() => decryptSecret(encrypted, context));
        expectNoCrypto();
        for (const error of [onEncrypt, onDecrypt]) {
          expect(error, String(tenantId)).toBeInstanceOf(SecretBoxValidationError);
          expect(error.message).toBe("Invalid tenantId: expected a UUID");
        }
      }
    }
  });

  it("throws a validation error for a purpose outside the closed list before any cryptographic operation", () => {
    const encrypted = encryptSecret(SECRET, A_ACCESS);
    for (const configured of [KEY_NEW, undefined]) {
      setKeys(configured);
      for (const purpose of badPurposes) {
        const context = { tenantId: TENANT_A, purpose } as unknown as SecretContext;
        resetSpies();
        const onEncrypt = thrown(() => encryptSecret(SECRET, context));
        const onDecrypt = thrown(() => decryptSecret(encrypted, context));
        expectNoCrypto();
        for (const error of [onEncrypt, onDecrypt]) {
          expect(error, String(purpose)).toBeInstanceOf(SecretBoxValidationError);
          expect(error.message).toContain("Invalid secret purpose");
        }
      }
    }
  });

  it("validates the secret before any cryptographic operation", () => {
    resetSpies();
    expect(thrown(() => encryptSecret("", A_ACCESS))).toBeInstanceOf(SecretBoxValidationError);
    expectNoCrypto();
    // The spies do see the primitives of the module: the checks above are meaningful.
    decryptSecret(encryptSecret(SECRET, A_ACCESS), A_ACCESS);
    for (const [name, spy] of Object.entries(spies)) expect(spy, name).toHaveBeenCalled();
  });
});

describe("secret box: no leaks", () => {
  it("never puts the secret, the key or the ciphertext in errors or logs", () => {
    setKeys(KEY_OLD);
    const oldValue = encryptSecret(SECRET, A_ACCESS);
    setKeys(KEY_NEW, KEY_OLD);
    const encrypted = encryptSecret(SECRET, A_ACCESS);
    const tampered = encrypted.slice(0, -2) + (encrypted.endsWith("A=") ? "B=" : "A=");
    const forbidden = [
      SECRET,
      KEY_NEW,
      KEY_OLD,
      Buffer.from(KEY_NEW, "base64").toString("hex"),
      encrypted,
      ...encrypted.split(":").slice(2),
      ...oldValue.split(":").slice(2),
    ];
    const failures = [
      () => decryptSecret(encrypted, { ...A_ACCESS, tenantId: TENANT_B }),
      () => decryptSecret(encrypted, { ...A_ACCESS, purpose: "fic_refresh_token" }),
      () => decryptSecret(tampered, A_ACCESS),
      () => decryptSecret(`${encrypted}:x`, A_ACCESS),
      () => decryptSecret(encrypted, { tenantId: SECRET, purpose: "fic_access_token" }),
      () => encryptSecret(SECRET, { tenantId: TENANT_A, purpose: SECRET as never }),
      () => {
        setKeys(KEY_OTHER);
        return decryptSecret(encrypted, A_ACCESS);
      },
      () => {
        setKeys(`${KEY_NEW} `);
        return encryptSecret(SECRET, A_ACCESS);
      },
    ];
    for (const failure of failures) {
      const error = thrown(failure);
      expect((error as { cause?: unknown }).cause).toBeUndefined();
      const text = errorText(error);
      for (const value of forbidden) expect(text).not.toContain(value);
      setKeys(KEY_NEW, KEY_OLD);
    }
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});
