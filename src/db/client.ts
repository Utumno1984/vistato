import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

/**
 * One connection pool per process, created lazily on first use so that importing
 * this module never requires DATABASE_URL (e.g. during `next build`).
 * In development Next.js reloads modules on every change, so the pool is cached on
 * globalThis to avoid exhausting connections.
 */
const globalForDb = globalThis as unknown as { sql?: postgres.Sql; db?: Database };

export function getSql(): postgres.Sql {
  if (!globalForDb.sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
    globalForDb.sql = postgres(url, { max: 10 });
  }
  return globalForDb.sql;
}

export function getDb(): Database {
  globalForDb.db ??= drizzle(getSql(), { schema });
  return globalForDb.db;
}
