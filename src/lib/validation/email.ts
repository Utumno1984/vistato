import { z } from "zod";

import { requiredTextSchema, tooLongMessage } from "./text";

/**
 * Technical anti-abuse cap on the raw value (before trimming), as for the other
 * free-text fields: the domain limit below is applied after trimming.
 */
export const EMAIL_MAX_RAW_LENGTH = 1000;

/** Maximum length of an email address (RFC 5321 path limit minus the angle brackets). */
export const EMAIL_MAX_LENGTH = 254;

/**
 * Email address: same pipeline as the other free-text fields (raw length cap, NFC,
 * linear `unicodeTrim`, no control or bidi characters), then at most 254 characters
 * and a practical address format (ASCII local part and domain, TLD of 2+ letters).
 *
 * The case is preserved: uniqueness per tenant is case-insensitive in the database
 * (`lower(email)` index), so the stored value stays as the user typed it.
 */
export const emailSchema = requiredTextSchema({
  requiredMessage: "L'email è obbligatoria",
  maxLength: EMAIL_MAX_RAW_LENGTH,
}).pipe(
  z
    .string()
    .max(EMAIL_MAX_LENGTH, { message: tooLongMessage(EMAIL_MAX_LENGTH), abort: true })
    .pipe(z.email("Email non valida")),
);
