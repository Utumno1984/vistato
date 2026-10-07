import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Tables with a `tenant_id` column, as exported by `@/db/schema`. Keep in sync with
 * the schema: `tests/unit/tenant-isolation-lint.test.ts` fails when a tenant-owned
 * table is missing from this list.
 */
export const TENANT_TABLES = ["users", "tenantModules"];

const SOURCE_EXTENSION = "(\\.[cm]?[jt]sx?)?";

/**
 * Tenant isolation: outside the data layer (`src/db/**`), the scripts and the tests,
 * code reaches tenant data only through `forTenant` (`@/db/tenant-scope`), never
 * with its own queries. Type-only imports stay allowed.
 */
const tenantIsolationPatterns = [
  {
    regex: `(^|/)db/client${SOURCE_EXTENSION}$`,
    allowTypeImports: true,
    message: "Use forTenant from @/db/tenant-scope (or a function of the data layer in src/db/).",
  },
  {
    regex: `(^|/)db/schema(/index)?${SOURCE_EXTENSION}$`,
    importNames: TENANT_TABLES,
    allowTypeImports: true,
    message: "Tenant-owned tables are reachable only through forTenant from @/db/tenant-scope.",
  },
  {
    regex: `(^|/)db/schema/(?!index${SOURCE_EXTENSION}$)[^/]+$`,
    allowTypeImports: true,
    message: "Import from @/db/schema; tenant-owned tables are reachable only through forTenant.",
  },
  {
    regex: "^(postgres|pg|drizzle-orm/.+)$",
    allowTypeImports: true,
    message: "Database connections and drivers belong to the data layer (src/db/).",
  },
];

/** Dynamic `import()` and `require()` of the same modules (literal specifiers only). */
const RESTRICTED_SPECIFIER = "/(^|\\W)db.(client|schema)(\\W|$)|^(postgres|pg|drizzle-orm.+)$/";
const dynamicImportMessage = "Tenant data is reachable only through forTenant from @/db/tenant-scope.";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    ignores: ["src/db/**", "scripts/**", "tests/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: tenantIsolationPatterns }],
      "no-restricted-syntax": [
        "error",
        { selector: `ImportExpression[source.value=${RESTRICTED_SPECIFIER}]`, message: dynamicImportMessage },
        {
          selector: `CallExpression[callee.name='require'][arguments.0.value=${RESTRICTED_SPECIFIER}]`,
          message: dynamicImportMessage,
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
