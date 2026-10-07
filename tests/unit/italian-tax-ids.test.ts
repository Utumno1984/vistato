import { describe, expect, it } from "vitest";

import {
  isValidTaxCode,
  isValidVatNumber,
  taxCodeSchema,
  vatNumberSchema,
} from "@/lib/validation/italian-tax-ids";

const cp = (...codePoints: number[]) => String.fromCodePoint(...codePoints);
const NBSP = cp(0xa0);

describe("isValidVatNumber", () => {
  it("accepts a VAT number with a correct check digit", () => {
    expect(isValidVatNumber("12345678903")).toBe(true);
  });

  it("rejects a VAT number with a wrong check digit", () => {
    expect(isValidVatNumber("12345678901")).toBe(false);
  });

  it.each(["", "123", "IT12345678903", "1234567890a", "123456789031", "1234567890", "12345 678903"])(
    "rejects %j",
    (value) => {
      expect(isValidVatNumber(value)).toBe(false);
    },
  );

  it("accepts 00000000000 (the algorithm alone is applied)", () => {
    expect(isValidVatNumber("00000000000")).toBe(true);
  });

  it("accepts other real-world-shaped numbers whose check digit is right", () => {
    // Even positions with a doubled digit > 9: 0*,7*2=14-9=5, ...
    expect(isValidVatNumber("07643520567")).toBe(true);
    expect(isValidVatNumber("07643520568")).toBe(false);
  });

  it("ignores white space at the edges but not inside", () => {
    expect(isValidVatNumber(" 12345678903\t")).toBe(true);
    expect(isValidVatNumber(`${NBSP}12345678903${NBSP}`)).toBe(true);
    expect(isValidVatNumber("123456 78903")).toBe(false);
  });

  it("rejects non-ASCII digits", () => {
    // Arabic-Indic digits for 12345678903
    const arabicIndic = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 3].map((d) => cp(0x0660 + d)).join("");
    expect(isValidVatNumber(arabicIndic)).toBe(false);
    // Fullwidth digits
    expect(isValidVatNumber("12345678903".replace(/[0-9]/g, (d) => cp(0xff10 + Number(d))))).toBe(false);
  });
});

/**
 * Characters that `toUpperCase()` maps to ASCII letters: they must never turn an
 * invalid tax code into a valid one.
 */
const UPPERCASES_TO_ASCII: [string, string][] = [
  ["sharp s (15 chars, SS when upper-cased)", `rssmra80a01h50${cp(0xdf)}`],
  ["fi ligature", `RSSMRA80A01H${cp(0xfb01)}01`],
  ["dotless i", `RSSMRA80A01H501${cp(0x131)}`],
  ["long s", `RSSMRA80A01H501${cp(0x17f)}`],
  ["Kelvin sign", `RSSMRA80A01H501${cp(0x212a)}`],
  ["fullwidth letter", `RSSMRA80A01H501${cp(0xff35)}`],
];

describe("isValidTaxCode", () => {
  it.each(["RSSMRA80A01H501U", "12345678903", "12345678901", "rssmra80a01h501u", " RSSMRA80A01H501U\n"])(
    "accepts %j",
    (value) => {
      expect(isValidTaxCode(value)).toBe(true);
    },
  );

  it.each([
    "",
    "RSSMRA80A01H501",
    "RSSMRA80A01H501UX",
    "RSSMRA80A01H50-U",
    "RSSMRA80A01H501 ",
    "RSSMRA 80A01H501U",
    "1234567890",
    "123456789012",
    `RSSMRA80A01H501${cp(0xc8)}`, // E with grave accent
  ])("rejects %j", (value) => {
    expect(isValidTaxCode(value)).toBe(false);
  });

  it.each(UPPERCASES_TO_ASCII)("rejects a non-ASCII character that upper-cases to ASCII: %s", (_label, value) => {
    expect(isValidTaxCode(value)).toBe(false);
    expect(taxCodeSchema.safeParse(value).success).toBe(false);
  });
});

describe("vatNumberSchema", () => {
  it("outputs the trimmed value", () => {
    expect(vatNumberSchema.parse(" 12345678903 ")).toBe("12345678903");
  });

  it("reports only the format error for a malformed value", () => {
    const result = vatNumberSchema.safeParse("IT12345678903");
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toEqual(["La partita IVA deve essere composta da 11 cifre"]);
  });

  it("reports the check digit error for a well-formed value", () => {
    const result = vatNumberSchema.safeParse("12345678901");
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toEqual([
      "La cifra di controllo della partita IVA non è corretta",
    ]);
  });
});

describe("taxCodeSchema", () => {
  it("outputs the trimmed, upper-cased value", () => {
    expect(taxCodeSchema.parse("  rssmra80a01h501u ")).toBe("RSSMRA80A01H501U");
  });

  it("rejects a malformed value", () => {
    expect(taxCodeSchema.safeParse("RSSMRA80A01H501").success).toBe(false);
  });
});

describe("tax identifiers and invisible or control characters", () => {
  it("removes invisible characters at the edges but rejects them inside", () => {
    const zwsp = cp(0x200b);
    const softHyphen = cp(0xad);
    expect(taxCodeSchema.parse(`${zwsp}rssmra80a01h501u${softHyphen}`)).toBe("RSSMRA80A01H501U");
    expect(taxCodeSchema.safeParse(`RSSMRA80${zwsp}A01H501U`).success).toBe(false);
    expect(vatNumberSchema.parse(`${softHyphen}12345678903${zwsp}`)).toBe("12345678903");
    expect(vatNumberSchema.safeParse(`123456${zwsp}78903`).success).toBe(false);
  });

  it.each([0x00, 0x09, 0x1f, 0x7f])("rejects a control character (code point %d) inside the value", (code) => {
    expect(taxCodeSchema.safeParse(`RSSMRA80${cp(code)}A01H501U`).success).toBe(false);
    expect(vatNumberSchema.safeParse(`123456${cp(code)}78903`).success).toBe(false);
  });
});
