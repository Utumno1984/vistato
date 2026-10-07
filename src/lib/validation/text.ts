import { z } from "zod";

/**
 * Characters stripped from the edges of every input string: Unicode white space
 * (spaces, tabs, line breaks, NBSP, ...) and default-ignorable code points, i.e.
 * characters rendered as nothing (zero-width spaces and joiners, BOM, soft hyphen,
 * Hangul fillers, invisible math operators, variation selectors, ...).
 *
 * The database CHECK on the business name uses `btrim`, which removes only ASCII
 * spaces: a value made of tabs or NBSPs would pass it, so blank detection must
 * happen here.
 */
const EDGE_BLANKS =
  /^[\p{White_Space}\p{Default_Ignorable_Code_Point}]+|[\p{White_Space}\p{Default_Ignorable_Code_Point}]+$/gu;

/** Control characters (C0, DEL, C1), including tab and line breaks. */
const CONTROL_CHARACTER = /\p{Cc}/u;

/** Removes Unicode white space and invisible characters from both ends. */
export function unicodeTrim(value: string): string {
  return value.replace(EDGE_BLANKS, "");
}

/**
 * Required single-line text: trimmed with `unicodeTrim`, then non-empty and free of
 * control characters (NUL would otherwise reach the database and fail there).
 */
export function requiredTextSchema(requiredMessage: string) {
  return z
    .string()
    .overwrite(unicodeTrim)
    .min(1, requiredMessage)
    .refine((value) => !CONTROL_CHARACTER.test(value), "Contiene caratteri di controllo non ammessi");
}
