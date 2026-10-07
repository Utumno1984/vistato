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
 *    `@/db/platform/*`), the internals of `@/db/tenant-scope`, the drivers, and
 *    `tests/` and `scripts/` (which may use the client).
 * 2. `no-restricted-imports` forbids non-canonical specifiers, which the resolver of
 *    (1) may fail to resolve (and then skips), and the database drivers by name.
 * 3. `no-restricted-syntax` forbids what (1) cannot see: `import()` and `require()`
 *    with a computed specifier, indirect `require` (`module.require`, aliases,
 *    `createRequire`), and the ways to reach the registered symbol of the pool
 *    (`<anything>.for(...)` with a computed or `vistato.db…` key, `.for` taken as a
 *    value, `getOwnPropertySymbols`, `Reflect.ownKeys`).
 * 4. `noInlineConfig`: an `eslint-disable` comment cannot switch these rules off.
 *
 * Accepted limits (static guardrail, not a sandbox; RLS is out of scope): `eval`,
 * `new Function`, `globalThis["Sym" + "bol"]` and similar dynamic tricks.
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
    {
      // Tests and scripts may use the client freely: a re-export there would open a hole.
      target: "./",
      from: ["./tests", "./scripts"],
      message: "Application code must not import from tests/ or scripts/.",
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

const POOL_IS_PRIVATE = "The database connection pool is private to src/db/. " + USE_FOR_TENANT;
const LITERAL_ONLY = "(checked by the tenant isolation rules).";

/** A member `.for` / `["for"]` (e.g. `Symbol.for`, `S.for`, `Symbol["for"]`). */
const FOR_MEMBER = "MemberExpression:matches([property.name='for'][computed=false], [property.value='for'])";

const restrictedSyntax = [
  {
    selector: "ImportExpression[source.type!='Literal']",
    message: `Dynamic imports must use a plain string literal ${LITERAL_ONLY}`,
  },
  {
    selector: "CallExpression[callee.name='require'][arguments.0.type!='Literal']",
    message: `require() must use a plain string literal ${LITERAL_ONLY}`,
  },
  {
    // `const r = require; r(...)`, `require.call(...)`, `fn(require)`: only direct calls.
    selector: "Identifier[name='require']:not(CallExpression > Identifier.callee)",
    message: `require may only be called directly, with a string literal ${LITERAL_ONLY}`,
  },
  {
    selector:
      "MemberExpression:matches([property.name='require'][computed=false], [property.value='require']), Identifier[name='createRequire']",
    message: `Use import or a direct require() with a string literal ${LITERAL_ONLY}`,
  },
  {
    // Any `x.for(...)` / `x["for"](...)`, whatever `x` is (covers `const S = Symbol`).
    selector: `CallExpression:matches([callee.property.name='for'][callee.computed=false], [callee.property.value='for']):matches([arguments.0.type!='Literal'], [arguments.0.value=/^vistato[.]db/i])`,
    message: POOL_IS_PRIVATE,
  },
  {
    // `const f = Symbol.for; f("vistato.db.pool")`, `Symbol.for.call(...)`.
    selector: `${FOR_MEMBER}:not(CallExpression > MemberExpression.callee)`,
    message: POOL_IS_PRIVATE,
  },
  {
    selector:
      "MemberExpression:matches([property.name='getOwnPropertySymbols'], [property.value='getOwnPropertySymbols'], [object.name='Reflect'][property.name='ownKeys'])",
    message: POOL_IS_PRIVATE,
  },
];

/**
 * eslint-config-next registers the `import` plugin and its resolver settings only for
 * `**\/*.{js,jsx,mjs,ts,tsx,mts,cts}`. The isolation block below applies to *every*
 * file ESLint lints (`.cjs` included), so it registers the same plugin object (a
 * different object under the same name would be a configuration error) and the same
 * resolver settings.
 */
const nextBase = nextVitals.find((config) => config.plugins?.import);
if (!nextBase) throw new Error("eslint-config-next no longer registers eslint-plugin-import");

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    name: "vistato/tenant-isolation",
    // No `files`: every file ESLint lints, whatever its extension, except the data
    // layer, the scripts and the tests (`tests/unit/tenant-isolation-lint.test.ts`
    // checks that every linted file of the repository gets these rules).
    ignores: ["src/db/**", "scripts/**", "tests/**"],
    plugins: { import: nextBase.plugins.import },
    settings: {
      "import/parsers": nextBase.settings["import/parsers"],
      "import/resolver": nextBase.settings["import/resolver"],
    },
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
