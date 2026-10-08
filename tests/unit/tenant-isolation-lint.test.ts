import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

import { getTableColumns, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";

/**
 * The ESLint rules that keep application code from bypassing `forTenant`, checked
 * by running ESLint (with the project configuration) on code fragments. Paths must
 * be real: `import/no-restricted-paths` resolves every specifier to a file.
 */
const ISOLATION_RULES = new Set(["import/no-restricted-paths", "no-restricted-imports", "no-restricted-syntax"]);
const ROOT = new URL("../..", import.meta.url).pathname;

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: ROOT });
});

/** Messages of the isolation rules for `code` linted as if it were the file `filePath`. */
async function isolationErrors(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  // A disable comment for a rule that is not configured yields "Definition for rule
  // ... was not found" under that rule ID: not a real report, so it does not count.
  return result.messages.filter(
    (m) => m.ruleId && ISOLATION_RULES.has(m.ruleId) && !m.message.startsWith("Definition for rule"),
  );
}

/** Names of the schema exports that are tables with a `tenant_id` column. */
const tenantTables = Object.entries(schema)
  .filter(([, value]) => is(value, PgTable) && Object.values(getTableColumns(value)).some((c) => c.name === "tenant_id"))
  .map(([name]) => name);

const APP_FILES = ["src/app/api/example/route.ts", "src/lib/example.ts", "src/app/page-example.tsx", "e2e/example.spec.ts"];

/** Forbidden with an alias or a bare specifier: the same from every application file. */
const FORBIDDEN: [string, string][] = [
  ["the Drizzle client", `import { getDb } from "@/db/client";`],
  ["the raw SQL client", `import { getSql } from "@/db/client";`],
  ["the client with its extension", `import { getDb } from "@/db/client.ts";`],
  ["the client type", `import type { Database } from "@/db/client";`],
  ["the users table", `import { users } from "@/db/schema";`],
  ["the tenant_modules table", `import { tenantModules } from "@/db/schema";`],
  ["a renamed tenant table", `import { users as people } from "@/db/schema";`],
  ["the whole schema as a namespace", `import * as schema from "@/db/schema";`],
  ["a side-effect import of the schema", `import "@/db/schema";`],
  ["a schema type", `import type { User } from "@/db/schema";`],
  ["a schema enum", `import { userRole } from "@/db/schema";`],
  ["the tenants table", `import { tenants } from "@/db/schema";`],
  ["the schema index file", `import { users } from "@/db/schema/index";`],
  ["a single schema file", `import { users } from "@/db/schema/users";`],
  ["a re-export of a tenant table", `export { users } from "@/db/schema";`],
  ["a re-export of the whole client", `export * from "@/db/client";`],
  // Non-canonical specifiers (critic, round 1).
  ["the schema with a trailing slash", `import { users } from "@/db/schema/";`],
  ["the schema through a dot segment", `import { users } from "@/db/./schema";`],
  ["the client through a dot segment", `import { getDb } from "@/db/./client";`],
  ["the client with a double slash", `import { getDb } from "@/db//client";`],
  ["the client through a parent segment", `import { getDb } from "@/db/client/../client";`],
  ["the client through another folder", `import { getDb } from "@/lib/../db/client";`],
  ["the schema index with a trailing dot", `import { users } from "@/db/schema/.";`],
  ["the client through a folder that does not exist", `import { getDb } from "@/db/nothing/../client";`],
  ["any module through a parent segment", `import { buildLinks } from "@/lib/x/../hateoas";`],
  // Internals of forTenant.
  ["the scoped users factory", `import { tenantUsers } from "@/db/tenant-scope/users";`],
  ["the tenant ID brand", `import type { TenantId } from "@/db/tenant-scope/tenant-id";`],
  ["a tenant-scope internal with its extension", `import { tenantUsers } from "@/db/tenant-scope/users.ts";`],
  ["a tenant-scope internal through a dot segment", `import { tenantUsers } from "@/db/tenant-scope/./users";`],
  // Drivers.
  ["the postgres driver", `import postgres from "postgres";`],
  ["a postgres subpath", `import postgres from "postgres/";`],
  ["the pg driver", `import { Pool } from "pg";`],
  ["a Drizzle driver", `import { drizzle } from "drizzle-orm/postgres-js";`],
  ["a Drizzle driver through a dot segment", `import { drizzle } from "drizzle-orm/./postgres-js";`],
  ["a package through node_modules", `import postgres from "../node_modules/postgres";`],
  // Dynamic access.
  ["a dynamic import of the client", `export const load = () => import("@/db/client");`],
  ["a dynamic import of a non-canonical client", `export const load = () => import("@/db//client");`],
  ["a dynamic import with a template literal", "export const load = () => import(`@/db/client`);"],
  ["a dynamic import with a computed specifier", `export const load = (m: string) => import("@/db/" + m);`],
  ["a require of the schema", `const s = require("@/db/schema");\nexport default s;`],
  ["a require with a computed specifier", `export const load = (m: string) => require(m);`],
  ["the symbol of the connection pool", `export const pool = (globalThis as never)[Symbol.for("vistato.db.pool")];`],
  ["a computed registered symbol", `export const key = (name: string) => Symbol.for(name);`],
  // Other ways to the pool symbol (critic, round 2).
  ["Symbol['for'] with the pool key", `export const k = Symbol["for"]("vistato.db.pool");`],
  ["an alias of Symbol", `const S = Symbol;\nexport const k = S.for("vistato.db.pool");`],
  ["Symbol through globalThis", `export const k = globalThis.Symbol.for("vistato.db.pool");`],
  ["Symbol.for taken as a value", `const f = Symbol.for;\nexport const k = f("vistato.db.pool");`],
  ["Symbol.for.call", `export const k = Symbol.for.call(null, "vistato.db.pool");`],
  ["the symbols of globalThis", `export const s = Object.getOwnPropertySymbols(globalThis);`],
  ["the keys of globalThis via Reflect", `export const s = Reflect.ownKeys(globalThis);`],
  // Indirect require (critic, round 2).
  ["module.require", `export const c = module.require("@/db/client");`],
  ["module['require']", `export const c = module["require"]("x");`],
  ["an alias of require", `const r = require;\nexport const c = r("@/db/client");`],
  ["createRequire", `import { createRequire } from "node:module";\nexport const r = createRequire(import.meta.url);`],
  // tests/ and scripts/ may use the client: no imports from there.
  ["a test helper", `import { testDb } from "@/../tests/helpers/db";`],
];

/**
 * Relative specifiers, with the file they are written in (they must resolve to the
 * real modules from there).
 */
const FORBIDDEN_RELATIVE: [string, string][] = [
  ["src/lib/example.ts", `import { getDb } from "../db/client";`],
  ["src/lib/example.ts", `import { testDb } from "../../tests/helpers/db";`],
  ["src/lib/example.ts", `export * from "../../tests/helpers/db";`],
  ["src/lib/example.ts", `import "../../scripts/seed";`],
  ["src/app/api/example.ts", `import { testDb } from "../../../tests/helpers/db";`],
  ["e2e/example.spec.ts", `import { testDb } from "../tests/helpers/db";`],
  ["src/lib/example.ts", `import { getDb } from "../lib/../db/client";`],
  ["src/lib/example.ts", `import { getDb } from "./missing/../../db/client";`],
  ["src/lib/example.ts", `import { getDb } from "../db/./client";`],
  ["src/lib/example.ts", `import { users } from "../db/schema/";`],
  ["src/lib/example.ts", `import { tenantUsers } from "../db/tenant-scope/users";`],
  ["src/app/api/example.ts", `import { getDb } from "../../db/client";`],
  ["src/app/api/example.ts", `import { users } from "../../db/schema/";`],
  ["src/app/api/example.ts", `import { getDb } from "../../db//client";`],
  ["src/app/api/example.ts", `import { getDb } from "../../../src/db/client";`],
  ["src/app/api/example.ts", `import { users } from "../../lib/../db/schema/index.ts";`],
  ["e2e/example.spec.ts", `import { getDb } from "../src/db/client";`],
];

const ALLOWED: [string, string][] = [
  ["forTenant", `import { forTenant } from "@/db/tenant-scope";`],
  ["forTenant with a trailing slash", `import { forTenant } from "@/db/tenant-scope/";`],
  ["forTenant through its index", `import { forTenant } from "@/db/tenant-scope/index";`],
  ["the user type re-exported by forTenant", `import type { User, UserRole } from "@/db/tenant-scope";`],
  ["the health check of the data layer", `import { pingDatabase } from "@/db/health";`],
  ["platform operations and their type", `import { createTenant, type Tenant } from "@/db/platform/tenants";`],
  ["typed errors", `import { ValidationError } from "@/db/errors";`],
  ["query helpers of drizzle-orm", `import { eq } from "drizzle-orm";`],
  ["other packages", `import { z } from "zod";`],
  ["a sibling module", `import { x } from "./sibling";`],
  ["a module in a parent folder", `import { x } from "../../parent/module";`],
  ["a dynamic import with a string literal", `export const load = () => import("@/lib/hateoas");`],
  ["another registered symbol", `export const key = Symbol.for("react.element");`],
  ["a well-known symbol", `export const iterator = [][Symbol.iterator];`],
];

/** JavaScript and TypeScript extensions: every one ESLint lints must get the rules. */
const SOURCE_EXTENSIONS = ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "d.ts", "d.mts", "d.cts"];
const RULE_NAMES = ["import/no-restricted-paths", "no-restricted-imports", "no-restricted-syntax"];

/** CommonJS files (critic, round 2: `.cjs` used to escape every isolation rule). */
const FORBIDDEN_CJS: [string, string, string][] = [
  ["the pool symbol", "src/lib/pool.cjs", `module.exports = () => globalThis[Symbol.for("vistato.db.pool")].db;`],
  ["a require of the client", "src/lib/leak.cjs", `module.exports = require("../db/client");`],
  ["a require of the schema", "src/app/leak.cjs", `const { users } = require("@/db/schema");\nmodule.exports = users;`],
  ["an import of the client", "src/lib/leak.cjs", `import("../db/client").then(console.log);`],
  [
    "a disabled require of the client",
    "src/lib/leak.cjs",
    `// eslint-disable-next-line import/no-restricted-paths\nmodule.exports = require("../db/client");`,
  ],
  [
    "a file-wide disable",
    "src/lib/leak.cjs",
    `/* eslint-disable */\nmodule.exports = () => globalThis[Symbol.for("vistato.db.pool")].db;`,
  ],
  ["module.require", "src/lib/leak.cjs", `module.exports = module.require("../db/client");`],
  ["an alias of require", "src/lib/leak.cjs", `const r = require;\nmodule.exports = r("../db/client");`],
  ["a require of the driver", "e2e/leak.cjs", `module.exports = require("postgres");`],
];

describe("tenant isolation lint rules", () => {
  it("know which schema exports are tenant-owned tables", () => {
    expect(tenantTables.sort()).toEqual(["invoices", "sessions", "tenantModules", "users"]);
  });

  describe.each(APP_FILES)("in %s", (filePath) => {
    it.each(FORBIDDEN)("report an import of %s", async (_label, code) => {
      const errors = await isolationErrors(code, filePath);
      expect(errors).not.toEqual([]);
      expect(errors.every((e) => e.severity === 2)).toBe(true);
    });

    it.each(ALLOWED)("allow an import of %s", async (_label, code) => {
      expect(await isolationErrors(code, filePath)).toEqual([]);
    });
  });

  it.each(FORBIDDEN_RELATIVE)("report, in %s, the relative import %s", async (filePath, code) => {
    expect(await isolationErrors(code, filePath)).not.toEqual([]);
  });

  it.each(FORBIDDEN_CJS)("report, in a CommonJS file, %s", async (_label, filePath, code) => {
    const errors = await isolationErrors(code, filePath);
    expect(errors).not.toEqual([]);
    expect(errors.every((e) => e.severity === 2)).toBe(true);
  });

  it("allow a CommonJS file that requires an ordinary package", async () => {
    expect(await isolationErrors(`module.exports = require("zod");`, "src/lib/ok.cjs")).toEqual([]);
  });

  /** True when `filePath` gets every isolation rule as an error, with inline config off. */
  async function isCovered(filePath: string): Promise<boolean> {
    const config = await eslint.calculateConfigForFile(filePath);
    if (!config) return false;
    const severityOf = (rule: string) => {
      const entry = config.rules?.[rule];
      return Array.isArray(entry) ? entry[0] : entry;
    };
    return (
      RULE_NAMES.every((rule) => [2, "error"].includes(severityOf(rule))) && config.linterOptions?.noInlineConfig === true
    );
  }

  it.each(SOURCE_EXTENSIONS.flatMap((ext) => ["src/lib", "src/app/api", "e2e", "."].map((dir) => `${dir}/x.${ext}`)))(
    "cover %s",
    async (filePath) => {
      expect(await isCovered(filePath)).toBe(true);
    },
  );

  it("cover every file of the repository that ESLint lints, outside src/db, scripts and tests", async () => {
    const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT })
      .toString()
      .split("\n")
      .filter(Boolean);
    const exempt = /^(src\/db|scripts|tests)\//;
    const uncovered: string[] = [];
    let linted = 0;
    for (const file of files) {
      if (exempt.test(file) || (await eslint.isPathIgnored(file))) continue;
      if (!(await eslint.calculateConfigForFile(file))) continue; // not linted at all (CSS, images, ...)
      linted++;
      if (!(await isCovered(file))) uncovered.push(file);
    }
    expect(linted).toBeGreaterThan(5);
    expect(uncovered).toEqual([]);
  });

  it("do not apply to the data layer, the scripts and the tests", async () => {
    for (const filePath of ["src/db/x.cjs", "src/db/x.ts", "scripts/x.ts", "tests/x.cjs"]) {
      const config = await eslint.calculateConfigForFile(filePath);
      expect(config?.rules?.["import/no-restricted-paths"], filePath).toBeUndefined();
    }
  });

  it("report every tenant-owned table of the schema", async () => {
    for (const table of tenantTables) {
      const errors = await isolationErrors(`import { ${table} } from "@/db/schema";`, "src/lib/example.ts");
      expect(errors, table).toHaveLength(1);
    }
  });

  it("report every file of the schema folder", async () => {
    const files = readdirSync(new URL("../../src/db/schema", import.meta.url)).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const code = `import * as m from "@/db/schema/${file.replace(/\.ts$/, "")}";\nexport default m;`;
      expect(await isolationErrors(code, "src/lib/example.ts"), file).toHaveLength(1);
    }
  });

  it("point to forTenant in the message", async () => {
    const [error] = await isolationErrors(`import { getDb } from "@/db/client";`, "src/app/api/example/route.ts");
    expect(error).toMatchObject({ ruleId: "import/no-restricted-paths", severity: 2 });
    expect(error.message).toContain("forTenant");
  });

  it.each([
    "// eslint-disable-next-line import/no-restricted-paths\nimport { getDb } from \"@/db/client\";",
    "/* eslint-disable */\nimport { getDb } from \"@/db/client\";",
    "import { getDb } from \"@/db/client\"; // eslint-disable-line",
    "/* eslint import/no-restricted-paths: \"off\" */\nimport { getDb } from \"@/db/client\";",
  ])("cannot be switched off by an inline comment: %j", async (code) => {
    const errors = await isolationErrors(code, "src/app/api/example/route.ts");
    expect(errors).toHaveLength(1);
    expect(errors[0].severity).toBe(2);
  });

  it.each(["src/db/example.ts", "src/db/tenant-scope/example.ts", "scripts/example.ts", "tests/integration/example.test.ts"])(
    "allow the data layer, scripts and tests (%s) to use the client and the tables",
    async (filePath) => {
      const code = [
        `import { getDb } from "@/db/client";`,
        `import { users } from "@/db/schema";`,
        `import { tenantUsers } from "@/db/tenant-scope/users";`,
        `import postgres from "postgres";`,
        `export const q = () => [getDb().select().from(users), tenantUsers, postgres];`,
      ].join("\n");
      expect(await isolationErrors(code, filePath)).toEqual([]);
    },
  );
}, 120_000);
