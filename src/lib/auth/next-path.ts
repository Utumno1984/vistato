/** Where the login leads when `next` is missing or not a safe internal path. */
export const DEFAULT_NEXT_PATH = "/fatture";

const FAKE_ORIGIN = "http://internal.invalid";

/**
 * The post-login destination: `value` if it is a relative path of this application,
 * otherwise `/fatture`. Accepts only strings that start with a single `/`, with no
 * backslash and no control characters, and that resolve to the same origin (no open redirect).
 * The query string is preserved.
 */
export function safeNextPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return DEFAULT_NEXT_PATH;
  if (!value.startsWith("/") || value.startsWith("//")) return DEFAULT_NEXT_PATH;
  // eslint-disable-next-line no-control-regex
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return DEFAULT_NEXT_PATH;
  try {
    if (new URL(value, FAKE_ORIGIN).origin !== FAKE_ORIGIN) return DEFAULT_NEXT_PATH;
  } catch {
    return DEFAULT_NEXT_PATH;
  }
  return value;
}
