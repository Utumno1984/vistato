/** Prints an error and its cause chain (e.g. the Postgres error behind a Drizzle query error). */
export function reportError(error: unknown): void {
  let current: unknown = error;
  let prefix = "";
  while (current) {
    console.error(prefix + (current instanceof Error ? current.message : String(current)));
    current = current instanceof Error ? current.cause : undefined;
    prefix = "Caused by: ";
  }
}
