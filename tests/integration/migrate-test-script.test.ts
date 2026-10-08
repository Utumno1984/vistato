import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTempDatabase, type TempDatabase } from "../helpers/temp-database";

const ROOT = path.resolve(__dirname, "../..");
const TSX = path.join(ROOT, "node_modules/.bin/tsx");
const SCRIPT = path.join(ROOT, "scripts/migrate-test.ts");

function runScript(env: NodeJS.ProcessEnv, cwd: string) {
  return spawnSync(TSX, [SCRIPT], { cwd, env, encoding: "utf8", timeout: 60_000 });
}

async function publicTables(db: TempDatabase): Promise<string[]> {
  const rows = await db.sql<{ table_name: string }[]>`
    select table_name from information_schema.tables where table_schema = 'public'`;
  return rows.map((r) => r.table_name);
}

describe("npm run db:migrate:test", () => {
  // Stands in for the development database (name without `_test`): it must never be touched.
  let devDb: TempDatabase;
  // A legitimate test database.
  let testDb: TempDatabase;
  let emptyDir: string;

  beforeEach(async () => {
    devDb = await createTempDatabase({ testSuffix: false });
    testDb = await createTempDatabase();
    emptyDir = mkdtempSync(path.join(tmpdir(), "vistato-no-env-"));
  });
  afterEach(async () => {
    await devDb.drop();
    await testDb.drop();
    rmSync(emptyDir, { recursive: true, force: true });
  });

  function baseEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: devDb.url };
    delete env.TEST_DATABASE_URL;
    return env;
  }

  it("fails without TEST_DATABASE_URL and leaves DATABASE_URL untouched", async () => {
    // Run outside the repository so no .env file can provide the variable.
    const result = runScript(baseEnv(), emptyDir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("TEST_DATABASE_URL");
    expect(await publicTables(devDb)).toEqual([]);
  });

  it("fails with an empty TEST_DATABASE_URL (not overridden by .env)", async () => {
    const result = runScript({ ...baseEnv(), TEST_DATABASE_URL: "" }, ROOT);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("TEST_DATABASE_URL");
    expect(await publicTables(devDb)).toEqual([]);
  });

  it("refuses a TEST_DATABASE_URL whose database name does not end with _test", async () => {
    const result = runScript({ ...baseEnv(), TEST_DATABASE_URL: devDb.url }, ROOT);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Refusing to use database "${devDb.name}"`);
    expect(await publicTables(devDb)).toEqual([]);
  });

  it("refuses a `database` query parameter that redirects to a non-test database", async () => {
    const url = new URL(testDb.url);
    url.searchParams.set("database", devDb.name);
    const result = runScript({ ...baseEnv(), TEST_DATABASE_URL: url.toString() }, ROOT);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Refusing to use database "${devDb.name}"`);
    expect(await publicTables(devDb)).toEqual([]);
    expect(await publicTables(testDb)).toEqual([]);
  });

  it("migrates the database at TEST_DATABASE_URL", async () => {
    const result = runScript({ ...baseEnv(), TEST_DATABASE_URL: testDb.url }, ROOT);

    expect(result.status, result.stderr).toBe(0);
    expect(await publicTables(testDb)).toEqual(
      expect.arrayContaining(["tenants", "users", "modules", "tenant_modules"]),
    );
    expect(await publicTables(devDb)).toEqual([]);
  });
});
