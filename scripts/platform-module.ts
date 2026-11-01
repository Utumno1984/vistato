/**
 * `npm run platform:module -- <activate|cancel> --tenant <uuid> --module <code>`
 *
 * PLATFORM OPERATION: activates or cancels a paid module for one tenant of the database
 * at DATABASE_URL, by hand, until billing exists. The tenant comes from the operator's
 * command line, never from a customer request.
 *
 * - activate: the module becomes active from now, with no expiry. Idempotent: if the
 *   tenant already has the module in effect (ACTIVE row, activated_at <= now and no
 *   expiry or a future one) nothing is written, dates included, and it exits 0. A CANCELLED,
 *   expired or not yet started row is reactivated from now with no expiry.
 * - cancel: the tenant's row becomes CANCELLED (dates kept). Idempotent: a module never
 *   activated or already CANCELLED is left as it is, exit 0.
 *
 * Exit codes: 0 done (or nothing to do); 2 invalid arguments (unknown action, missing or
 * repeated option, tenant not a UUID, module unknown or base); 1 tenant not found or any
 * other error. On a non-zero exit nothing has been written.
 */
import "dotenv/config";

import { parseArgs } from "node:util";

import { z } from "zod";

import { MODULE_CATALOG, type ModuleCode } from "../src/db/catalog/modules";
import { closeDb } from "../src/db/client";
import { findTenantById } from "../src/db/platform/tenants";
import { forTenant, type TenantModule } from "../src/db/tenant-scope";
import { reportError } from "./report-error";

const USAGE = "Usage: npm run platform:module -- <activate|cancel> --tenant <uuid> --module <code>";
const PAID_MODULES = MODULE_CATALOG.filter((m) => !m.isBase).map((m) => m.code);

class UsageError extends Error {}

interface Command {
  action: "activate" | "cancel";
  tenantId: string;
  code: ModuleCode;
}

function single(name: string, values: string[] | undefined): string {
  if (!values || values.length === 0) throw new UsageError(`Missing --${name}.`);
  if (values.length > 1) throw new UsageError(`--${name} given more than once.`);
  return values[0];
}

function parseCommand(argv: string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: { tenant: { type: "string", multiple: true }, module: { type: "string", multiple: true } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  const [action, ...extra] = parsed.positionals;
  if (action !== "activate" && action !== "cancel") {
    throw new UsageError(action === undefined ? "Missing action." : `Unknown action "${action}".`);
  }
  if (extra.length > 0) throw new UsageError(`Unexpected arguments: ${extra.join(" ")}.`);

  const tenantId = single("tenant", parsed.values.tenant);
  if (!z.uuid().safeParse(tenantId).success) throw new UsageError(`Invalid tenant ID "${tenantId}": expected a UUID.`);

  const code = single("module", parsed.values.module);
  const entry = MODULE_CATALOG.find((m) => m.code === code);
  if (!entry) throw new UsageError(`Unknown module "${code}". Paid modules: ${PAID_MODULES.join(", ")}.`);
  if (entry.isBase) {
    throw new UsageError(`Module "${code}" is a base module: it is always active and cannot be activated or cancelled.`);
  }
  return { action, tenantId, code: entry.code };
}

/** Same row rule as `hasModule` (activation inclusive, expiry exclusive), without the tenant status. */
function inEffect(row: TenantModule, at: Date): boolean {
  return row.status === "ACTIVE" && row.activatedAt <= at && (row.expiresAt === null || row.expiresAt > at);
}

async function run({ action, tenantId, code }: Command): Promise<number> {
  if (!process.env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL is not set (see .env.example)");

  const tenant = await findTenantById(tenantId);
  if (!tenant) {
    console.error(`Tenant ${tenantId} not found: nothing changed.`);
    return 1;
  }
  const label = `tenant ${tenant.id} (${tenant.businessName})`;
  const scope = forTenant(tenant.id);
  const existing = (await scope.modules.list()).find((row) => row.code === code);
  const now = new Date();

  if (action === "activate") {
    if (existing && inEffect(existing, now)) {
      console.log(`Module ${code} is already active for ${label}: nothing changed.`);
    } else {
      await scope.modules.activate(code, { activatedAt: now, expiresAt: null });
      console.log(`Module ${code} activated for ${label}.`);
    }
    if (tenant.status !== "ACTIVE") {
      console.warn(`Warning: the tenant is ${tenant.status}: no module is usable until it is ACTIVE again.`);
    }
    return 0;
  }

  if (!existing || existing.status === "CANCELLED") {
    console.log(`Module ${code} is not active for ${label}: nothing changed.`);
  } else {
    await scope.modules.cancel(code);
    console.log(`Module ${code} cancelled for ${label}.`);
  }
  return 0;
}

async function main(): Promise<number> {
  let command: Command;
  try {
    command = parseCommand(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message} Nothing changed.\n${USAGE}`);
    return 2;
  }
  try {
    return await run(command);
  } finally {
    await closeDb();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    reportError(error);
    process.exit(1);
  },
);
