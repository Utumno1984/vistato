/**
 * Formats a calendar date `YYYY-MM-DD` as `gg/mm/aaaa`. It is text manipulation on purpose:
 * a calendar date has no time zone and must never go through `Date` (no shift of one day).
 * A value in another format is returned unchanged.
 */
export function formatDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : isoDate;
}

/** Formats a UTC instant as `gg/mm/aaaa HH:MM` in the Europe/Rome time zone. */
export function formatDateTime(instant: Date | string): string {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  if (Number.isNaN(date.getTime())) return String(instant);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("it-IT", {
      timeZone: "Europe/Rome",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}
