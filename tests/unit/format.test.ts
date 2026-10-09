import { describe, expect, it } from "vitest";

import { formatAmount } from "@/lib/format/amount";
import { formatDate, formatDateTime } from "@/lib/format/date";

describe("formatAmount", () => {
  it("formats cents in the Italian style with the euro sign", () => {
    expect(formatAmount(123450, "EUR")).toBe("1.234,50 €");
    expect(formatAmount(5, "EUR")).toBe("0,05 €");
    expect(formatAmount(100, "EUR")).toBe("1,00 €");
    expect(formatAmount(99999, "EUR")).toBe("999,99 €");
    expect(formatAmount(100000, "EUR")).toBe("1.000,00 €");
  });

  it("handles zero and negative amounts", () => {
    expect(formatAmount(0, "EUR")).toBe("0,00 €");
    expect(formatAmount(-1000, "EUR")).toBe("-10,00 €");
    expect(formatAmount(-5, "EUR")).toBe("-0,05 €");
    expect(formatAmount(-123456789, "EUR")).toBe("-1.234.567,89 €");
  });

  it("shows the ISO code for other currencies", () => {
    expect(formatAmount(10000, "USD")).toBe("100,00 USD");
    expect(formatAmount(10000, "CHF")).toBe("100,00 CHF");
  });

  it("makes no rounding error on large amounts", () => {
    expect(formatAmount(1999999999999, "EUR")).toBe("19.999.999.999,99 €");
    expect(formatAmount(Number.MAX_SAFE_INTEGER, "EUR")).toBe("90.071.992.547.409,91 €");
    expect(formatAmount(-Number.MAX_SAFE_INTEGER, "EUR")).toBe("-90.071.992.547.409,91 €");
  });

  it("refuses non-integer or unsafe amounts", () => {
    expect(() => formatAmount(1.5, "EUR")).toThrow(RangeError);
    expect(() => formatAmount(Number.NaN, "EUR")).toThrow(RangeError);
    expect(() => formatAmount(Number.MAX_SAFE_INTEGER + 1, "EUR")).toThrow(RangeError);
  });
});

describe("formatDate", () => {
  it("turns a calendar date into gg/mm/aaaa without any time zone shift", () => {
    expect(formatDate("2026-03-05")).toBe("05/03/2026");
    expect(formatDate("2024-02-29")).toBe("29/02/2024");
    expect(formatDate("2026-01-01")).toBe("01/01/2026");
    expect(formatDate("2026-12-31")).toBe("31/12/2026");
  });

  it("returns an unexpected value unchanged", () => {
    expect(formatDate("05/03/2026")).toBe("05/03/2026");
    expect(formatDate("")).toBe("");
  });
});

describe("formatDateTime", () => {
  it("shows a UTC instant in Europe/Rome, with summer and winter time", () => {
    expect(formatDateTime("2026-07-01T10:30:00Z")).toBe("01/07/2026 12:30");
    expect(formatDateTime(new Date("2026-01-15T10:30:00Z"))).toBe("15/01/2026 11:30");
  });

  it("moves to the next day across midnight", () => {
    expect(formatDateTime("2026-03-05T23:30:00Z")).toBe("06/03/2026 00:30");
  });

  it("follows the daylight saving change at the end of October", () => {
    expect(formatDateTime("2026-10-24T22:30:00Z")).toBe("25/10/2026 00:30");
    expect(formatDateTime("2026-10-25T23:30:00Z")).toBe("26/10/2026 00:30");
  });

  it("returns an invalid instant as text", () => {
    expect(formatDateTime("boh")).toBe("boh");
  });
});
