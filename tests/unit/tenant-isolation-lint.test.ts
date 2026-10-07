import { getTableColumns, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";

/**
 * The ESLint rule that keeps application code from bypassing `forTenant`, checked by
 * running ESLint (with the project configuration) on code fragments.
 */
const ISOLATION_RULES = new Set(["no-restricted-imports", "no-restricted-syntax"]);

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: new URL("../..", import.meta.url).pathname });
});

/** Messages of the isolation rules for `code` linted as if it were the file `filePath`. */
async function isolationErrors(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((m) => m.ruleId && ISOLATION_RULES.has(m.ruleId));
}

/** Names of the schema exports that are tables with a `tenant_id` column. */
const tenantTables = Object.entries(schema)
  .filter(([, value]) => is(value, PgTable) && Object.values(getTableColumns(value)).some((c) => c.name === "tenant_id"))
  .map(([name]) => name);

const APP_FILES = ["src/app/api/example/route.ts", "src/lib/example.ts", "src/app/page-example.tsx"];

const FORBIDDEN: [string, string][] = [
  ["the Drizzle client", `import { getDb } from "@/db/client";`],
  ["the raw SQL client", `import { getSql } from "@/db/client";`],
  ["the client through a relative path", `import { getDb } from "../../db/client";`],
  ["the users table", `import { users } from "@/db/schema";`],
  ["the tenant_modules table", `import { tenantModules } from "@/db/schema";`],
  ["a renamed tenant table", `import { users as people } from "@/db/schema";`],
  ["the whole schema as a namespace", `import * as schema from "@/db/schema";`],
  ["the schema index file", `import { users } from "@/db/schema/index";`],
  ["a table through a relative path", `import { users } from "../db/schema";`],
  ["a single schema file", `import { users } from "@/db/schema/users";`],
  ["a re-export of a tenant table", `export { users } from "@/db/schema";`],
  ["the postgres driver", `import postgres from "postgres";`],
  ["a Drizzle driver", `import { drizzle } from "drizzle-orm/postgres-js";`],
  ["a dynamic import of the client", `export const load = () => import("@/db/client");`],
  ["a require of the schema", `const s = require("@/db/schema");\nexport default s;`],
];

const ALLOWED: [string, string][] = [
  ["forTenant", `import { forTenant } from "@/db/tenant-scope";`],
  ["the health check of the data layer", `import { pingDatabase } from "@/db/health";`],
  ["platform operations", `import { createTenant } from "@/db/platform/tenants";`],
  ["typed errors", `import { ValidationError } from "@/db/errors";`],
  ["a schema type", `import type { User } from "@/db/schema";`],
  ["a type-only import of a tenant table", `import type { users } from "@/db/schema";`],
  ["a type-only import of the client", `import type { Database } from "@/db/client";`],
  ["an enum of the schema", `import { userRole } from "@/db/schema";`],
  ["the tenants table, which has no tenant_id", `import { tenants } from "@/db/schema";`],
  ["query helpers of drizzle-orm", `import { eq } from "drizzle-orm";`],
];

describe("tenant isolation lint rule", () => {
  it("knows which schema exports are tenant-owned tables", () => {
    expect(tenantTables.sort()).toEqual(["tenantModules", "users"]);
  });

  describe.each(APP_FILES)("in %s", (filePath) => {
    it.each(FORBIDDEN)("reports an import of %s", async (_label, code) => {
      expect(await isolationErrors(code, filePath)).not.toEqual([]);
    });

    it.each(ALLOWED)("allows an import of %s", async (_label, code) => {
      expect(await isolationErrors(code, filePath)).toEqual([]);
    });
  });

  it("reports every tenant-owned table of the schema", async () => {
    for (const table of tenantTables) {
      const errors = await isolationErrors(`import { ${table} } from "@/db/schema";`, "src/lib/example.ts");
      expect(errors, table).toHaveLength(1);
      expect(errors[0].severity).toBe(2);
    }
  });

  it("reports the import as an error, with a hint to use forTenant", async () => {
    const [error] = await isolationErrors(`import { getDb } from "@/db/client";`, "src/app/api/example/route.ts");
    expect(error).toMatchObject({ ruleId: "no-restricted-imports", severity: 2 });
    expect(error.message).toContain("forTenant");
  });

  it.each(["src/db/example.ts", "src/db/tenant-scope/example.ts", "scripts/example.ts", "tests/integration/example.test.ts"])(
    "allows the data layer, scripts and tests (%s) to use the client and the tables",
    async (filePath) => {
      const code = `import { getDb } from "@/db/client";\nimport { users } from "@/db/schema";\nexport const q = () => getDb().select().from(users);`;
      expect(await isolationErrors(code, filePath)).toEqual([]);
    },
  );
}, 60_000);
