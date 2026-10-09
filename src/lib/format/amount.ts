/** Currencies shown with a symbol; any other is shown with its ISO code. */
const SYMBOLS: Readonly<Record<string, string>> = { EUR: "€" };

/**
 * Formats signed integer cents in the Italian style: `1.234,50 €`, `-10,00 €`, `100,00 USD`.
 * Pure integer arithmetic (BigInt): no floating point, so no rounding error at any size.
 */
export function formatAmount(cents: number, currency: string): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError("Amount must be a safe integer number of cents");
  const value = BigInt(cents);
  const absolute = cents < 0 ? -value : value;
  const hundred = BigInt(100);
  const whole = (absolute / hundred).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const fraction = (absolute % hundred).toString().padStart(2, "0");
  return `${cents < 0 ? "-" : ""}${whole},${fraction} ${SYMBOLS[currency] ?? currency}`;
}
