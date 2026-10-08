import { z } from "zod";

/**
 * A single code point that is Unicode white space (spaces, tabs, line breaks, NBSP,
 * ...) or default-ignorable, i.e. rendered as nothing (zero-width spaces and
 * joiners, BOM, soft hyphen, Hangul fillers, invisible math operators, bidi marks,
 * variation selectors, tags, ...).
 *
 * Tested one code point at a time: a regex such as `/^[...]+|[...]+$/` backtracks on
 * every run of inner blanks and takes quadratic time (same flaw as CVE-2020-7753).
 */
const BLANK_CODE_POINT = /^[\p{White_Space}\p{Default_Ignorable_Code_Point}]$/u;

function isBlank(codePoint: string): boolean {
  return BLANK_CODE_POINT.test(codePoint);
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/**
 * Removes Unicode white space and invisible characters from both ends, in linear
 * time: one scan forwards and one backwards, by code point.
 *
 * The database CHECK on the business name uses `btrim`, which removes only ASCII
 * spaces: a value made of tabs or NBSPs would pass it, so blank detection must
 * happen here.
 */
export function unicodeTrim(value: string): string {
  let start = 0;
  while (start < value.length) {
    const width = isHighSurrogate(value.charCodeAt(start)) && isLowSurrogate(value.charCodeAt(start + 1)) ? 2 : 1;
    if (!isBlank(value.slice(start, start + width))) break;
    start += width;
  }

  let end = value.length;
  while (end > start) {
    const width =
      end - 2 >= start && isLowSurrogate(value.charCodeAt(end - 1)) && isHighSurrogate(value.charCodeAt(end - 2))
        ? 2
        : 1;
    if (!isBlank(value.slice(end - width, end))) break;
    end -= width;
  }

  return start === 0 && end === value.length ? value : value.slice(start, end);
}

/** A lone (unpaired) UTF-16 surrogate: in `u` mode only those match `\p{Cs}`. */
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * Characters that make a single-line value ambiguous or deceptive: control
 * characters (C0, DEL, C1, including tab and line breaks), bidirectional controls
 * (which can visually reorder the text), line and paragraph separators.
 */
const FORBIDDEN_CHARACTER = /[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/u;

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Error for a raw value longer than `max` UTF-16 code units. */
export function tooLongMessage(max: number): string {
  return `Non può superare ${max} caratteri`;
}

export interface RequiredTextOptions {
  /** Message when the value is empty after trimming. */
  requiredMessage: string;
  /** Anti-abuse cap on the raw input (UTF-16 code units, before trimming). */
  maxLength: number;
}

/**
 * Required single-line text, e.g. a business name:
 * 1. raw length capped before any processing;
 * 2. well-formed UTF-16 (no lone surrogates, which would be stored as U+FFFD);
 * 3. NFC-normalised and trimmed with `unicodeTrim`;
 * 4. non-empty, without control, bidi or line/paragraph separator characters,
 *    and with at least one letter or digit.
 */
export function requiredTextSchema({ requiredMessage, maxLength }: RequiredTextOptions) {
  return z
    .string()
    .max(maxLength, { message: tooLongMessage(maxLength), abort: true })
    .refine((value) => !LONE_SURROGATE.test(value), { message: "Contiene caratteri non validi", abort: true })
    .overwrite((value) => unicodeTrim(value.normalize("NFC")))
    .min(1, { message: requiredMessage, abort: true })
    .refine((value) => !FORBIDDEN_CHARACTER.test(value), {
      message: "Contiene caratteri di controllo non ammessi",
      abort: true,
    })
    .refine((value) => LETTER_OR_DIGIT.test(value), "Deve contenere almeno una lettera o una cifra");
}
