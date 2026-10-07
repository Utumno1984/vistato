import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * TENANT ISOLATION. Outside the data layer (`src/db/**`), the scripts and the tests,
 * code reaches tenant data only through `forTenant` (`@/db/tenant-scope`), never
 * with its own queries. `tests/unit/tenant-isolation-lint.test.ts` runs ESLint on
 * code fragments to check every restriction below.
 *
 * 1. `import/no-restricted-paths` works on the *resolved* file (same resolver as the
 *    rest of eslint-plugin-import: tsconfig paths, relative paths, `..`, `.`, `//`,
 *    trailing slashes, extensions), so a non-canonical specifier cannot bypass it.
 *    Forbidden: the Drizzle client, the whole schema (tables, enums and types: the
 *    types the application needs are re-exported by `@/db/tenant-scope` and
 *    `@/db/platform/*`) and the internals of `@/db/tenant-scope`.
 * 2. `no-restricted-imports` forbids non-canonical specifiers, which the resolver of
 *    (1) may fail to resolve (and then skips), and the database drivers by name.
 * 3. `no-restricted-syntax` forbids what (1) cannot see: `import()` and `require()`
 *    with a computed specifier, and the registered symbol of the connection pool.
 * 4. `noInlineConfig`: an `eslint-disable` comment cannot switch these rules off.
 */
const ROOT = import.meta.dirname;
const USE_FOR_TENANT = "Tenant data is reachable only through forTenant from @/db/tenant-scope.";

const restrictedPaths = {
  basePath: ROOT,
  zones: [
    { target: "./", from: "./src/db/client.ts", message: USE_FOR_TENANT },
    { target: "./", from: "./src/db/schema", message: USE_FOR_TENANT },
    {
      target: "./",
      from: "./src/db/tenant-scope",
      except: ["./index.ts"],
      message: "Import forTenant from @/db/tenant-scope, not its internal modules.",
    },
    {
      target: "./",
      from: ["./node_modules/postgres", "./node_modules/pg"],
      message: "Database connections belong to the data layer (src/db/).",
    },
  ],
};

const restrictedSpecifiers = {
  patterns: [
    {
      // `import/no-restricted-paths` silently skips what its resolver cannot find,
      // e.g. `@/db/client/../client` (no `client/` folder) that bundlers and tsc
      // normalise lexically: so `.`/`..` segments are allowed only as the leading
      // relative prefix, and empty segments (`//`) never.
      regex: "(^|/)(?!\\.{1,2}(/|$))[^/]+/([^/]+/)*\\.{1,2}(/|$)|//",
      message: "Write the import path in canonical form (no '.', '..' or empty segments after a folder name).",
    },
    {
      regex: "^(postgres|pg)(/.*)?$|^drizzle-orm/.+$",
      message: "Database connections and drivers belong to the data layer (src/db/).",
    },
    {
      regex: "(^|/)node_modules(/|$)",
      message: "Import packages by name, not through node_modules.",
    },
  ],
};

const restrictedSyntax = [
  {
    selector: "ImportExpression[source.type!='Literal']",
    message: "Dynamic imports must use a plain string literal (checked by the tenant isolation rules).",
  },
  {
    selector: "CallExpression[callee.name='require'][arguments.0.type!='Literal']",
    message: "require() must use a plain string literal (checked by the tenant isolation rules).",
  },
  {
    selector:
      "CallExpression[callee.object.name='Symbol'][callee.property.name='for']:matches([arguments.0.type!='Literal'], [arguments.0.value=/^vistato[.]db/i])",
    message: "The database connection pool is private to src/db/. " + USE_FOR_TENANT,
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    name: "vistato/tenant-isolation",
    // Same file set as eslint-config-next, which registers the `import` plugin.
    files: ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"],
    ignores: ["src/db/**", "scripts/**", "tests/**"],
    linterOptions: { noInlineConfig: true },
    rules: {
      "import/no-restricted-paths": ["error", restrictedPaths],
      "no-restricted-imports": ["error", restrictedSpecifiers],
      "no-restricted-syntax": ["error", ...restrictedSyntax],
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
