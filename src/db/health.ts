import { getSql } from "@/db/client";

/** True when the database answers a trivial query; false on any error (never throws). */
export async function pingDatabase(): Promise<boolean> {
  try {
    await getSql()`select 1`;
    return true;
  } catch {
    return false;
  }
}
