import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

/**
 * One connection pool per process, created lazily on first use so that importing
 * this module never requires DATABASE_URL (e.g. during `next build`).
 * In development Next.js reloads modules on every change, so the pool is cached on
 * globalThis to avoid exhausting connections.
 *
 * The cache lives under a registered symbol, not a plain property such as
 * `globalThis.db`, so that application code cannot reach the client by accident
 * (an ESLint rule also forbids `Symbol.for("vistato.db...")` outside `src/db/`).
 * `Symbol.for` returns the same symbol after a reload, which keeps the HMR cache.
 */
const POOL_KEY = Symbol.for("vistato.db.pool");

interface PoolCache {
  sql?: postgres.Sql;
  db?: Database;
}

function cache(): PoolCache {
  const holder = globalThis as unknown as Record<symbol, PoolCache | undefined>;
  holder[POOL_KEY] ??= {};
  return holder[POOL_KEY];
}

export function getSql(): postgres.Sql {
  const pool = cache();
  if (!pool.sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
    pool.sql = postgres(url, { max: 10 });
  }
  return pool.sql;
}

export function getDb(): Database {
  const pool = cache();
  pool.db ??= drizzle(getSql(), { schema });
  return pool.db;
}

/**
 * Closes the pool and forgets it: the next `getSql`/`getDb` opens a new one (and
 * reads DATABASE_URL again). For tests and graceful shutdown.
 */
export async function closeDb(): Promise<void> {
  const pool = cache();
  const sql = pool.sql;
  pool.sql = undefined;
  pool.db = undefined;
  await sql?.end();
}
