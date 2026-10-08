import { describe, expect, it } from "vitest";

import { EMAIL_MAX_LENGTH, EMAIL_MAX_RAW_LENGTH, emailSchema } from "@/lib/validation/email";

const cp = (...codePoints: number[]) => String.fromCodePoint(...codePoints);

function issues(value: unknown): string[] {
  const parsed = emailSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
}

describe("emailSchema", () => {
  it.each(["mario@acme.it", "Mario.Rossi@Acme.IT", "mario+fatture@acme.co.uk", "m_rossi-1@sub.acme-group.com"])(
    "accepts %s unchanged",
    (email) => {
      expect(emailSchema.parse(email)).toBe(email);
    },
  );

  it("trims white space and invisible characters at both ends, keeping the case", () => {
    expect(emailSchema.parse(` ${cp(0xa0)}\t${cp(0x200b)}MARIO@acme.it${cp(0xfeff)}\n`)).toBe("MARIO@acme.it");
  });

  it.each([
    ["empty", ""],
    ["blank", ` ${cp(0xa0)} `],
  ])("rejects an %s value as required", (_label, value) => {
    expect(issues(value)).toEqual(["L'email è obbligatoria"]);
  });

  it.each([
    "mario",
    "mario@",
    "@acme.it",
    "mario@acme",
    "mario@@acme.it",
    "mario rossi@acme.it",
    ".mario@acme.it",
    "ma..rio@acme.it",
    "mario@acme.i",
    "màrio@acme.it",
  ])("rejects the malformed address %j", (value) => {
    expect(issues(value)).toEqual(["Email non valida"]);
  });

  it.each([
    ["NUL", cp(0)],
    ["line feed", "\n"],
    ["DEL", cp(0x7f)],
    ["right-to-left override", cp(0x202e)],
  ])("rejects a %s inside the address", (_label, char) => {
    expect(issues(`mario${char}@acme.it`)).toEqual(["Contiene caratteri di controllo non ammessi"]);
  });

  it("rejects a lone surrogate", () => {
    expect(issues("mario\ud800@acme.it")).toEqual(["Contiene caratteri non validi"]);
  });

  it.each([null, undefined, 42, {}])("rejects the non-string %j", (value) => {
    expect(issues(value)).toHaveLength(1);
  });

  it(`accepts ${EMAIL_MAX_LENGTH} characters and rejects one more`, () => {
    const domain = "@acme.it";
    const atLimit = "a".repeat(EMAIL_MAX_LENGTH - domain.length) + domain;
    expect(emailSchema.parse(atLimit)).toBe(atLimit);
    expect(issues(`a${atLimit}`)).toEqual([`Non può superare ${EMAIL_MAX_LENGTH} caratteri`]);
  });

  it("caps the raw value before trimming", () => {
    const padded = " ".repeat(EMAIL_MAX_RAW_LENGTH) + "mario@acme.it";
    expect(issues(padded)).toEqual([`Non può superare ${EMAIL_MAX_RAW_LENGTH} caratteri`]);
    expect(emailSchema.parse(" ".repeat(EMAIL_MAX_RAW_LENGTH - 13) + "mario@acme.it")).toBe("mario@acme.it");
  });

  it("validates a maximal hostile input quickly", () => {
    const hostile = ["a".repeat(EMAIL_MAX_LENGTH), "a.".repeat(500), `${"a-".repeat(120)}@${"a-".repeat(120)}`];
    const start = performance.now();
    for (const value of hostile) emailSchema.safeParse(value);
    expect(performance.now() - start).toBeLessThan(200);
  });
});
