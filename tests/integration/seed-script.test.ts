import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateDatabase } from "@/db/migrate";

import { createTempDatabase, type TempDatabase } from "../helpers/temp-database";

const ROOT = path.resolve(__dirname, "../..");
const TSX = path.join(ROOT, "node_modules/.bin/tsx");
const SCRIPT = path.join(ROOT, "scripts/seed.ts");

describe("npm run db:seed (scripts/seed.ts)", () => {
  let db: TempDatabase;
  let emptyDir: string;

  beforeEach(async () => {
    db = await createTempDatabase();
    await migrateDatabase(db.url, { testOnly: true });
    emptyDir = mkdtempSync(path.join(tmpdir(), "vistato-seed-"));
  });
  afterEach(async () => {
    await db.drop();
    rmSync(emptyDir, { recursive: true, force: true });
  });

  function run(demoPassword?: string) {
    const env = { PATH: process.env.PATH, DATABASE_URL: db.url } as unknown as NodeJS.ProcessEnv;
    if (demoPassword !== undefined) env.DEMO_USER_PASSWORD = demoPassword;
    // cwd without a .env file: only the variables above are visible.
    return spawnSync(TSX, ["--tsconfig", path.join(ROOT, "tsconfig.json"), SCRIPT], { cwd: emptyDir, env, encoding: "utf8", timeout: 60_000 });
  }
  const count = async (table: string) =>
    Number((await db.sql.unsafe(`select count(*) as n from ${table}`))[0].n);

  it("without DEMO_USER_PASSWORD writes the catalogue, warns and exits 0", async () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("DEMO_USER_PASSWORD is not set");
    expect(await count("modules")).toBe(4);
    expect(await count("tenants")).toBe(0);
    expect(await count("users")).toBe(0);
  });

  it("with a password shorter than 12 characters exits non-zero and creates no demo data", async () => {
    const result = run("short-pw-11");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("at least 12 characters");
    expect(await count("tenants")).toBe(0);
    expect(await count("users")).toBe(0);
  });

  it("with a valid password creates the demo tenant and user, also when run twice", async () => {
    expect(run("demo-password-123").status).toBe(0);
    expect(run("demo-password-123").status).toBe(0);
    expect(await count("tenants")).toBe(1);
    expect(await count("users")).toBe(1);
  });
});
