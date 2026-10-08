import { hash, verify } from "@node-rs/argon2";

/** Password length bounds, in UTF-16 code units (`string.length`). No normalisation, no other rule. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1024;

// Algorithm.Argon2id === 2; the package's const enum cannot be imported under isolated modules.
const ARGON2ID = 2;

/** OWASP parameters for argon2id: 19 MiB, 2 iterations, 1 lane. */
const OPTIONS = { algorithm: ARGON2ID, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

/** Hashes a password into a self-describing `$argon2id$...` string (random salt). */
export async function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

/** True when `password` matches `passwordHash`. A malformed hash is a mismatch, never an error. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
