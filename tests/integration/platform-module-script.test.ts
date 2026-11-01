import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hasModule } from "@/db/entitlements";
import { requireTestDatabaseUrl } from "@/db/migrate";
import { createTenant, setTenantStatus } from "@/db/platform/tenants";
import { forTenant } from "@/db/tenant-scope";

import { testDb, testSql } from "../helpers/db";

const ROOT = path.resolve(__dirname, "../..");
const TSX = path.join(ROOT, "node_modules/.bin/tsx");
const SCRIPT = path.join(ROOT, "scripts/platform-module.ts");
const UNKNOWN_UUID = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const PAST = new Date("2026-01-01T00:00:00.000Z");

interface Result {
  status: number;
  stdout: string;
  stderr: string;
}

// Every test spawns the script (tsx start-up, about 1 s each): the 5 s default is too short for 2-4 runs.
describe("npm run platform:module (scripts/platform-module.ts)", { timeout: 60_000 }, () => {
  let emptyDir: string;
  let tenantA: string;
  let tenantB: string;

  beforeEach(async () => {
    emptyDir = mkdtempSync(path.join(tmpdir(), "vistato-platform-module-"));
    tenantA = (await createTenant({ businessName: "Acme S.r.l.", vatNumber: "12345678903" }, testDb())).id;
    tenantB = (await createTenant({ businessName: "Beta S.r.l.", taxCode: "RSSMRA80A01H501U" }, testDb())).id;
  });
  afterEach(() => rmSync(emptyDir, { recursive: true, force: true }));

  /** `databaseUrl` null: DATABASE_URL is not set for the script. */
  function run(args: string[], databaseUrl: string | null = requireTestDatabaseUrl()): Promise<Result> {
    const env = { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv;
    if (databaseUrl !== null) env.DATABASE_URL = databaseUrl;
    // cwd without a .env file: only the variables above are visible.
    return new Promise((resolve) => {
      execFile(
        TSX,
        ["--tsconfig", path.join(ROOT, "tsconfig.json"), SCRIPT, ...args],
        { cwd: emptyDir, env, encoding: "utf8", timeout: 60_000 },
        (error, stdout, stderr) => {
          const status = error ? (typeof error.code === "number" ? error.code : -1) : 0;
          resolve({ status, stdout, stderr });
        },
      );
    });
  }
  const activate = (tenant: string, module = "fic_iban_alert") => run(["activate", "--tenant", tenant, "--module", module]);
  const cancel = (tenant: string, module = "fic_iban_alert") => run(["cancel", "--tenant", tenant, "--module", module]);
  const has = (tenant: string) => hasModule(tenant, "fic_iban_alert", new Date(), testDb());
  const allRows = () => testSql()`select * from tenant_modules order by id`;

  it("activates fic_iban_alert on an existing tenant (exit 0), and cancel deactivates it", async () => {
    expect(await has(tenantA)).toBe(false);

    const activated = await activate(tenantA);
    expect(activated.status).toBe(0);
    expect(activated.stdout).toContain(`Module fic_iban_alert activated for tenant ${tenantA}`);
    expect(await has(tenantA)).toBe(true);
    const [row] = await forTenant(tenantA, testDb()).modules.list();
    expect(row).toMatchObject({ code: "fic_iban_alert", status: "ACTIVE", expiresAt: null });

    const cancelled = await cancel(tenantA);
    expect(cancelled.status).toBe(0);
    expect(cancelled.stdout).toContain(`Module fic_iban_alert cancelled for tenant ${tenantA}`);
    expect(await has(tenantA)).toBe(false);
  });

  it("does not touch tenant B when activating on tenant A", async () => {
    expect((await activate(tenantA)).status).toBe(0);
    expect(await has(tenantA)).toBe(true);
    expect(await has(tenantB)).toBe(false);
    expect(await forTenant(tenantB, testDb()).modules.list()).toEqual([]);
  });

  it("is idempotent: a second activation exits 0, says it is already active and writes nothing", async () => {
    expect((await activate(tenantA)).status).toBe(0);
    const before = await allRows();

    const again = await activate(tenantA);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("already active");
    expect(await allRows()).toEqual(before);
    expect(await has(tenantA)).toBe(true);
  });

  it("keeps a future expiry on a module already in effect", async () => {
    const expiresAt = new Date(Date.now() + 86_400_000);
    await forTenant(tenantA, testDb()).modules.activate("fic_iban_alert", { activatedAt: PAST, expiresAt });
    const before = await allRows();

    const result = await activate(tenantA);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("already active");
    expect(await allRows()).toEqual(before);
  });

  it("reactivates from now, with no expiry, a module that expired or was cancelled", async () => {
    const scope = forTenant(tenantA, testDb());
    await scope.modules.activate("fic_iban_alert", { activatedAt: PAST, expiresAt: new Date(Date.now() - 1000) });
    expect(await has(tenantA)).toBe(false);
    expect((await activate(tenantA)).status).toBe(0);
    expect(await has(tenantA)).toBe(true);
    expect((await scope.modules.list())[0].expiresAt).toBeNull();

    await scope.modules.cancel("fic_iban_alert");
    expect((await activate(tenantA)).status).toBe(0);
    expect(await has(tenantA)).toBe(true);
    expect(await allRows()).toHaveLength(1);
  });

  it("is idempotent on cancel: a module never activated or already cancelled exits 0 and writes nothing", async () => {
    const never = await cancel(tenantA);
    expect(never.status).toBe(0);
    expect(never.stdout).toContain("is not active");
    expect(await allRows()).toHaveLength(0);

    expect((await activate(tenantA)).status).toBe(0);
    expect((await cancel(tenantA)).status).toBe(0);
    const before = await allRows();
    const again = await cancel(tenantA);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("is not active");
    expect(await allRows()).toEqual(before);
  });

  it("activates on a SUSPENDED tenant with a warning, but the module stays unusable until it is ACTIVE", async () => {
    await setTenantStatus(tenantA, "SUSPENDED", testDb());
    const result = await activate(tenantA);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("the tenant is SUSPENDED");
    expect(await has(tenantA)).toBe(false);
    await setTenantStatus(tenantA, "ACTIVE", testDb());
    expect(await has(tenantA)).toBe(true);
  });

  it("exits non-zero with a clear message and writes nothing for a tenant that does not exist", async () => {
    for (const result of await Promise.all([activate(UNKNOWN_UUID), cancel(UNKNOWN_UUID)])) {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`Tenant ${UNKNOWN_UUID} not found: nothing changed.`);
    }
    expect(await allRows()).toHaveLength(0);
  });

  it("exits non-zero with a clear message and writes nothing for invalid arguments", async () => {
    const cases: [string[], string][] = [
      [["activate", "--tenant", "not-a-uuid", "--module", "fic_iban_alert"], 'Invalid tenant ID "not-a-uuid": expected a UUID.'],
      [["activate", "--tenant", `${tenantA}x`, "--module", "fic_iban_alert"], "expected a UUID"],
      [["activate", "--tenant", tenantA, "--module", "iban_alert"], 'Unknown module "iban_alert". Paid modules: cost_centers, purchase_orders, payment_schedule, fic_iban_alert.'],
      [["cancel", "--tenant", tenantA, "--module", "nonexistent"], 'Unknown module "nonexistent"'],
      [["activate", "--tenant", tenantA, "--module", "approvals"], 'Module "approvals" is a base module'],
      [["activate", "--tenant", tenantA], "Missing --module."],
      [["activate", "--module", "fic_iban_alert"], "Missing --tenant."],
      [["--tenant", tenantA, "--module", "fic_iban_alert"], "Missing action."],
      [["enable", "--tenant", tenantA, "--module", "fic_iban_alert"], 'Unknown action "enable".'],
      [["activate", "--tenant", tenantA, "--tenant", tenantB, "--module", "fic_iban_alert"], "--tenant given more than once."],
      [["activate", "--tenant", tenantA, "--module", "fic_iban_alert", "--force"], "--force"],
      [["activate", "extra", "--tenant", tenantA, "--module", "fic_iban_alert"], "Unexpected arguments: extra."],
    ];
    const results = await Promise.all(cases.map(([args]) => run(args)));
    results.forEach((result, i) => {
      const [args, message] = cases[i];
      expect(result.status, args.join(" ")).toBe(2);
      expect(result.stderr, args.join(" ")).toContain(message);
      expect(result.stderr, args.join(" ")).toContain("Usage: npm run platform:module --");
    });
    expect(await allRows()).toHaveLength(0);
  });

  it("exits non-zero without DATABASE_URL", async () => {
    const result = await run(["activate", "--tenant", tenantA, "--module", "fic_iban_alert"], null);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL is not set");
    expect(await allRows()).toHaveLength(0);
  });
});
