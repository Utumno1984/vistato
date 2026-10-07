import { z } from "zod";

/**
 * Characters stripped from the edges of every input string: Unicode white space
 * (spaces, tabs, line breaks, NBSP, ...) plus the invisible zero-width characters
 * (ZWSP, ZWNJ, ZWJ, word joiner, BOM) that `String.prototype.trim` keeps.
 *
 * The database CHECK on the business name uses `btrim`, which removes only ASCII
 * spaces: a value made of tabs or NBSPs would pass it, so blank detection must
 * happen here.
 */
const EDGE_BLANKS = /^[\p{White_Space}​-‍⁠﻿]+|[\p{White_Space}​-‍⁠﻿]+$/gu;

/** Removes Unicode white space and zero-width characters from both ends. */
export function unicodeTrim(value: string): string {
  return value.replace(EDGE_BLANKS, "");
}

const VAT_NUMBER_FORMAT = /^[0-9]{11}$/;
const TAX_CODE_FORMAT = /^(?:[0-9]{11}|[A-Z0-9]{16})$/;

/** Partita IVA normalisation: trim only (no "IT" prefix removal, no inner spaces removal). */
export function normalizeVatNumber(value: string): string {
  return unicodeTrim(value);
}

/** Codice fiscale normalisation: trim and upper-case. */
export function normalizeTaxCode(value: string): string {
  return unicodeTrim(value).toUpperCase();
}

/**
 * Check digit of an Italian VAT number: digits in odd positions (1st, 3rd, ..., 9th)
 * are summed as they are; digits in even positions are doubled, minus 9 if > 9.
 * The 11th digit must equal (10 - sum mod 10) mod 10.
 * Expects a string of exactly 11 ASCII digits.
 */
function hasValidVatCheckDigit(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const digit = digits.charCodeAt(i) - 48;
    if (i % 2 === 0) {
      sum += digit;
    } else {
      const doubled = digit * 2;
      sum += doubled > 9 ? doubled - 9 : doubled;
    }
  }
  return (10 - (sum % 10)) % 10 === digits.charCodeAt(10) - 48;
}

/** True for exactly 11 digits (after trim) with a correct check digit. */
export function isValidVatNumber(value: string): boolean {
  const normalized = normalizeVatNumber(value);
  return VAT_NUMBER_FORMAT.test(normalized) && hasValidVatCheckDigit(normalized);
}

/**
 * True for 11 digits (companies) or 16 alphanumerics (people, including omocodia),
 * after trim and upper-casing. The CF check character is not verified, and an
 * 11-digit CF is not subject to the VAT algorithm.
 */
export function isValidTaxCode(value: string): boolean {
  return TAX_CODE_FORMAT.test(normalizeTaxCode(value));
}

/** Partita IVA: trimmed, 11 digits, valid check digit. Outputs the normalised value. */
export const vatNumberSchema = z
  .string()
  .overwrite(normalizeVatNumber)
  .regex(VAT_NUMBER_FORMAT, "La partita IVA deve essere composta da 11 cifre")
  .refine((value) => !VAT_NUMBER_FORMAT.test(value) || hasValidVatCheckDigit(value), {
    message: "La cifra di controllo della partita IVA non è corretta",
  });

/** Codice fiscale: trimmed, upper-cased, 11 digits or 16 alphanumerics. Outputs the normalised value. */
export const taxCodeSchema = z
  .string()
  .overwrite(normalizeTaxCode)
  .regex(TAX_CODE_FORMAT, "Il codice fiscale deve essere di 11 cifre o di 16 caratteri alfanumerici");
