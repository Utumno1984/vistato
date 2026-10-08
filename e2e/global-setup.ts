import { execFileSync } from "node:child_process";

import "dotenv/config";

/**
 * Runs once before the Playwright suite: `npm run db:seed` (module catalogue and demo
 * tenant/user) on the database at DATABASE_URL, since the integration tests empty the
 * shared database before the e2e run. It runs as a separate process because Playwright
 * loads TypeScript as CommonJS, which cannot load `src/db/migrate.ts` (`import.meta`).
 */
export default function globalSetup() {
  if (!process.env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL is not set (see .env.example)");
  execFileSync("npm", ["run", "--silent", "db:seed"], { stdio: "inherit", env: process.env });
}
