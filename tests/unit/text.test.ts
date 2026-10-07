import { describe, expect, it } from "vitest";

import { requiredTextSchema, unicodeTrim } from "@/lib/validation/text";

const cp = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
const NBSP = cp(0xa0);

/** Blank-looking characters: white space and default-ignorable (invisible) code points. */
const BLANKS: [string, number][] = [
  ["space", 0x20],
  ["tab", 0x09],
  ["line feed", 0x0a],
  ["carriage return", 0x0d],
  ["NBSP", 0xa0],
  ["soft hyphen", 0xad],
  ["Hangul choseong filler", 0x115f],
  ["Hangul jungseong filler", 0x1160],
  ["figure space", 0x2007],
  ["zero width space", 0x200b],
  ["zero width non-joiner", 0x200c],
  ["zero width joiner", 0x200d],
  ["word joiner", 0x2060],
  ["function application", 0x2061],
  ["invisible times", 0x2062],
  ["invisible separator", 0x2063],
  ["invisible plus", 0x2064],
  ["ideographic space", 0x3000],
  ["Hangul filler", 0x3164],
  ["byte order mark", 0xfeff],
  ["halfwidth Hangul filler", 0xffa0],
];

describe("unicodeTrim", () => {
  it.each(BLANKS)("removes %s at both edges", (_label, code) => {
    const c = cp(code);
    expect(unicodeTrim(`${c}${c}Acme S.r.l.${c}`)).toBe("Acme S.r.l.");
    expect(unicodeTrim(c.repeat(3))).toBe("");
  });

  it("removes a mix of all of them", () => {
    const all = BLANKS.map(([, code]) => cp(code)).join("");
    expect(unicodeTrim(`${all}Acme${all}`)).toBe("Acme");
  });

  it("keeps inner characters", () => {
    expect(unicodeTrim(`Acme${NBSP}${cp(0x200b)}S.r.l.`)).toBe(`Acme${NBSP}${cp(0x200b)}S.r.l.`);
  });
});

describe("requiredTextSchema", () => {
  const schema = requiredTextSchema("Campo obbligatorio");

  it("outputs the trimmed value", () => {
    expect(schema.parse(`${NBSP} Acme S.r.l.\n`)).toBe("Acme S.r.l.");
  });

  it("keeps ordinary punctuation and accented letters", () => {
    expect(schema.parse("Caffè & Più d'Italia S.r.l. - Società Benefit")).toBe("Caffè & Più d'Italia S.r.l. - Società Benefit");
  });

  it.each(BLANKS)("rejects a value made only of %s as required", (_label, code) => {
    const result = schema.safeParse(cp(code).repeat(2));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toEqual(["Campo obbligatorio"]);
  });

  it.each([
    ["NUL", 0x00],
    ["bell", 0x07],
    ["backspace", 0x08],
    ["escape", 0x1b],
    ["unit separator", 0x1f],
    ["DEL", 0x7f],
    ["C1 control", 0x85],
    ["C1 control", 0x9f],
    ["inner tab", 0x09],
    ["inner line feed", 0x0a],
    ["inner carriage return", 0x0d],
  ])("rejects a control character inside the value (%s, code point %d)", (_label, code) => {
    const result = schema.safeParse(`Acme${cp(code)}S.r.l.`);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toEqual(["Contiene caratteri di controllo non ammessi"]);
  });

  it("rejects a value made only of NUL characters", () => {
    expect(schema.safeParse(cp(0, 0)).success).toBe(false);
  });
});
