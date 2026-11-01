import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes, type CipherGCM, type DecipherGCM } from "node:crypto";

import { z } from "zod";

/**
 * At-rest encryption of per-tenant secrets (e.g. the Fatture in Cloud OAuth tokens) with
 * AES-256-GCM. Every ciphertext is bound to a tenant and a purpose through the AAD: a value
 * copied to another tenant, or read for another purpose, does not decrypt.
 *
 * Format (self-describing, versioned): `v1:<keyId>:<iv b64>:<tag b64>:<ciphertext b64>`.
 * `keyId` is a short fingerprint of the key (never the key) used to pick the current or the
 * previous key, so that `SECRETS_ENCRYPTION_KEY` can be rotated: set the new key there and
 * the old one in `SECRETS_ENCRYPTION_KEY_PREVIOUS`; values of the old key still decrypt and
 * are reported with `needsReencryption: true`. New values always use the current key.
 *
 * The keys are read from the environment at every call (no module-level state), so the app
 * starts without them: only a call to encrypt or decrypt requires them.
 *
 * Errors never carry the secret, the key or the ciphertext (no `cause` either).
 */

/** Closed list of what a secret may be used for. Later tickets may add entries. */
export const SECRET_PURPOSES = ["fic_access_token", "fic_refresh_token"] as const;
export type SecretPurpose = (typeof SECRET_PURPOSES)[number];

export interface SecretContext {
  tenantId: string;
  purpose: SecretPurpose;
}

export interface DecryptedSecret {
  plaintext: string;
  /** True when the value was encrypted with the previous key: encrypt it again and save it. */
  needsReencryption: boolean;
}

/** The key environment variables are missing or malformed. The message names the variable only. */
export class SecretBoxConfigError extends Error {
  override name = "SecretBoxConfigError";
}

/** Invalid tenant ID, purpose or secret: raised before any cryptographic operation. */
export class SecretBoxValidationError extends Error {
  override name = "SecretBoxValidationError";
}

/** The value cannot be decrypted (tampered, wrong tenant/purpose/key, unknown format). */
export class SecretDecryptionError extends Error {
  override name = "SecretDecryptionError";
  constructor() {
    super("The secret cannot be decrypted");
  }
}

export const CURRENT_KEY_ENV = "SECRETS_ENCRYPTION_KEY";
export const PREVIOUS_KEY_ENV = "SECRETS_ENCRYPTION_KEY_PREVIOUS";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_PATTERN = /^[0-9a-f]{16}$/;
/** Canonical, padded standard base64 (no whitespace, no URL alphabet). */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const contextSchema = z.object({
  tenantId: z.uuid(),
  purpose: z.enum(SECRET_PURPOSES),
});

interface Key {
  id: string;
  bytes: Buffer;
}

/** Strict base64 decoding: null unless `value` is canonical base64 (Buffer.from alone ignores junk). */
function decodeBase64(value: string): Buffer | null {
  if (!BASE64_PATTERN.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

function keyId(bytes: Buffer): string {
  return createHash("sha256").update("vistato-secret-box-key-id\0").update(bytes).digest("hex").slice(0, 16);
}

/** Parses a key variable. Whitespace is not trimmed: a key with spaces around is malformed. */
function parseKey(name: string, value: string): Key {
  const bytes = decodeBase64(value);
  if (!bytes) {
    throw new SecretBoxConfigError(
      `${name} is not valid base64 (no spaces or line breaks allowed); generate it with: openssl rand -base64 32`,
    );
  }
  if (bytes.length !== KEY_BYTES) {
    throw new SecretBoxConfigError(
      `${name} must decode to ${KEY_BYTES} bytes, not ${bytes.length}; generate it with: openssl rand -base64 32`,
    );
  }
  return { id: keyId(bytes), bytes };
}

/** The current key (required) and the previous one (optional; ignored when equal to the current). */
function loadKeys(): { current: Key; previous: Key | null } {
  const currentValue = process.env[CURRENT_KEY_ENV];
  if (currentValue === undefined || currentValue === "") {
    throw new SecretBoxConfigError(`${CURRENT_KEY_ENV} is not set; generate it with: openssl rand -base64 32`);
  }
  const current = parseKey(CURRENT_KEY_ENV, currentValue);
  const previousValue = process.env[PREVIOUS_KEY_ENV];
  if (previousValue === undefined || previousValue === "") return { current, previous: null };
  const previous = parseKey(PREVIOUS_KEY_ENV, previousValue);
  return { current, previous: previous.id === current.id ? null : previous };
}

function validateContext(context: SecretContext): SecretContext {
  const parsed = contextSchema.safeParse(context);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0] === "purpose" ? "purpose" : "tenantId";
    throw new SecretBoxValidationError(
      field === "purpose"
        ? `Invalid secret purpose; allowed: ${SECRET_PURPOSES.join(", ")}`
        : "Invalid tenantId: expected a UUID",
    );
  }
  // Same tenant whatever the letter case of the UUID.
  return { tenantId: parsed.data.tenantId.toLowerCase(), purpose: parsed.data.purpose };
}

/** Binds the ciphertext to format version, tenant and purpose (NUL-separated: unambiguous). */
function additionalData({ tenantId, purpose }: SecretContext): Buffer {
  return Buffer.from(`vistato-secret-box\0${VERSION}\0${tenantId}\0${purpose}`, "utf8");
}

/**
 * Encrypts `plaintext` for the tenant and purpose of `context`, with the current key and a
 * fresh random 12-byte IV. The empty string is refused: no secret is legitimately empty and
 * storing one would hide a bug (e.g. a token missing from an OAuth response).
 */
export function encryptSecret(plaintext: string, context: SecretContext): string {
  const valid = validateContext(context);
  if (typeof plaintext !== "string" || plaintext === "") {
    throw new SecretBoxValidationError("The secret must be a non-empty string");
  }
  if (!plaintext.isWellFormed()) {
    // UTF-8 encoding would silently replace a lone surrogate with U+FFFD.
    throw new SecretBoxValidationError("The secret contains invalid Unicode (lone surrogate)");
  }
  const { current } = loadKeys();
  const iv = randomBytes(IV_BYTES);
  const cipher: CipherGCM = createCipheriv(ALGORITHM, current.bytes, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(additionalData(valid));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, current.id, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

/**
 * Decrypts a value produced by `encryptSecret` for the same tenant and purpose. Throws
 * `SecretDecryptionError` (never partial data) for any tampering, unknown format or key,
 * or a different tenant/purpose.
 */
export function decryptSecret(encrypted: string, context: SecretContext): DecryptedSecret {
  const valid = validateContext(context);
  const { current, previous } = loadKeys();

  if (typeof encrypted !== "string") throw new SecretDecryptionError();
  const parts = encrypted.split(":");
  if (parts.length !== 5) throw new SecretDecryptionError();
  const [version, id, ivText, tagText, ciphertextText] = parts;
  if (version !== VERSION || !KEY_ID_PATTERN.test(id)) throw new SecretDecryptionError();
  const iv = decodeBase64(ivText);
  const tag = decodeBase64(tagText);
  const ciphertext = decodeBase64(ciphertextText);
  if (!iv || iv.length !== IV_BYTES || !tag || tag.length !== TAG_BYTES || !ciphertext || ciphertext.length === 0) {
    throw new SecretDecryptionError();
  }

  const key = id === current.id ? current : id === previous?.id ? previous : null;
  if (!key) throw new SecretDecryptionError();

  let plaintext: string;
  try {
    const decipher: DecipherGCM = createDecipheriv(ALGORITHM, key.bytes, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(additionalData(valid));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // The original error is dropped on purpose: no cause, nothing about the input.
    throw new SecretDecryptionError();
  }
  return { plaintext, needsReencryption: key !== current };
}
