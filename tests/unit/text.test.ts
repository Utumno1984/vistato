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

  it("handles supplementary-plane invisible characters (surrogate pairs) at both edges", () => {
    const tag = cp(0xe0001); // LANGUAGE TAG, default-ignorable, outside the BMP
    const emoji = cp(0x1f600);
    expect(unicodeTrim(`${tag}${tag}Acme${tag}`)).toBe("Acme");
    expect(unicodeTrim(`${tag}${emoji}${tag}`)).toBe(emoji);
    expect(unicodeTrim(`${emoji} `)).toBe(emoji);
  });

  it("returns the input unchanged when there is nothing to trim, and empty for empty", () => {
    expect(unicodeTrim("Acme")).toBe("Acme");
    expect(unicodeTrim("")).toBe("");
  });

  it("runs in linear time on long runs of inner blanks (regression: regex backtracking)", () => {
    const time = (n: number) => {
      const value = `a${" ".repeat(n)}a`;
      const start = performance.now();
      const result = unicodeTrim(value);
      const elapsed = performance.now() - start;
      expect(result).toBe(value);
      return elapsed;
    };
    time(1_000); // warm-up
    const timings = [10_000, 20_000, 40_000, 80_000].map((n) => [n, Math.round(time(n))]);
    const elapsed100k = time(100_000);
    expect(elapsed100k, `ms per inner-blank count: ${JSON.stringify(timings)}`).toBeLessThan(50);
  });

  it("trims long runs of edge blanks in linear time too", () => {
    const blanks = ` ${NBSP}${cp(0x200b)}${cp(0xe0001)}`.repeat(25_000); // 100,000 code points
    const value = `${blanks}a ${cp(0x1f600)} a${blanks}`;
    unicodeTrim(value); // warm-up
    const start = performance.now();
    expect(unicodeTrim(value)).toBe(`a ${cp(0x1f600)} a`);
    const elapsed = performance.now() - start;
    // About 10 ms locally; the quadratic regex took seconds. Loose bound for slow CI runners.
    expect(elapsed, `${elapsed} ms`).toBeLessThan(200);
  });
});

describe("requiredTextSchema", () => {
  const schema = requiredTextSchema({ requiredMessage: "Campo obbligatorio", maxLength: 1000 });
  const messages = (value: string) => schema.safeParse(value).error?.issues.map((i) => i.message);

  it("outputs the trimmed value", () => {
    expect(schema.parse(`${NBSP} Acme S.r.l.\n`)).toBe("Acme S.r.l.");
  });

  it.each([
    "Caffè & Più d'Italia S.r.l. - Società Benefit",
    "Società Àlfa d'Italia & C. S.n.c.",
    `Acme${NBSP}S.r.l.`,
    // CJK: "Tokyo Trading Co., Ltd."
    cp(0x6771, 0x4eac, 0x5546, 0x4e8b, 0x682a, 0x5f0f, 0x4f1a, 0x793e),
    "3M Italia S.r.l.",
    "A2A S.p.A.",
    `L${cp(0x2019)}Orafo (Firenze) S.a.s.`, // typographic apostrophe
    `Acme ${cp(0x1f600)} S.r.l.`, // emoji: a well-formed surrogate pair
  ])("accepts the legitimate name %j unchanged", (value) => {
    expect(schema.parse(value)).toBe(value);
  });

  it("normalises to NFC", () => {
    const decomposed = `Societa${cp(0x300)} A${cp(0x300)}lfa`; // a + combining grave, A + combining grave
    const composed = `Societ${cp(0xe0)} ${cp(0xc0)}lfa`;
    expect(decomposed).not.toBe(composed);
    expect(schema.parse(decomposed)).toBe(composed);
  });

  it.each([
    ["combining acute accent", cp(0x301)],
    ["combining marks", cp(0x301, 0x302, 0x308)],
    ["punctuation", ".-&'"],
    ["symbols", cp(0x2605, 0x2022)],
    ["emoji", cp(0x1f600)],
  ])("rejects a value without any letter or digit (%s)", (_label, value) => {
    expect(messages(value)).toEqual(["Deve contenere almeno una lettera o una cifra"]);
  });

  it.each([
    ["lone high surrogate at the end", `Acme${String.fromCharCode(0xd800)}`],
    ["lone low surrogate inside", `Ac${String.fromCharCode(0xdc00)}me`],
    ["reversed surrogate pair", `Acme${String.fromCharCode(0xde00, 0xd83d)}`],
  ])("rejects malformed UTF-16 (%s)", (_label, value) => {
    expect(messages(value)).toEqual(["Contiene caratteri non validi"]);
  });

  it.each([
    ["left-to-right mark", 0x200e],
    ["right-to-left mark", 0x200f],
    ["Arabic letter mark", 0x61c],
    ["left-to-right embedding", 0x202a],
    ["right-to-left override", 0x202e],
    ["pop directional formatting", 0x202c],
    ["left-to-right isolate", 0x2066],
    ["first strong isolate", 0x2068],
    ["pop directional isolate", 0x2069],
    ["line separator", 0x2028],
    ["paragraph separator", 0x2029],
  ])("rejects %s inside the value", (_label, code) => {
    expect(messages(`Acme${cp(code)}S.r.l.`)).toEqual(["Contiene caratteri di controllo non ammessi"]);
  });

  it("rejects a right-to-left override that would reverse part of the name", () => {
    expect(schema.safeParse(`Acme ${cp(0x202e)}l.r.S`).success).toBe(false);
  });

  it("accepts exactly the maximum length and rejects one more character, before trimming", () => {
    expect(schema.parse("a".repeat(1000))).toHaveLength(1000);
    expect(messages("a".repeat(1001))).toEqual(["Non può superare 1000 caratteri"]);
    // The cap applies to the raw input: blanks that the trim would remove still count.
    expect(messages(`Acme${" ".repeat(1000)}`)).toEqual(["Non può superare 1000 caratteri"]);
  });

  it("rejects a huge input quickly, without trimming it", () => {
    const huge = `a${" ".repeat(5_000_000)}a`;
    const start = performance.now();
    expect(messages(huge)).toEqual(["Non può superare 1000 caratteri"]);
    expect(performance.now() - start).toBeLessThan(200);
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
