import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const MATRIX_PATH = "docs/regression-matrix.md";

interface Row {
  feature: string;
  sources: string[];
  tests: { file: string; name: string }[];
  notCovered: boolean;
}

/** Table rows of the matrix (header and separator excluded). */
function parseMatrix(markdown: string): Row[] {
  const rows: Row[] = [];
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 3) continue;
    if (cells[0] === "Funzionalità" || /^-+$/.test(cells[0])) continue;
    const [feature, , coverage] = cells;
    rows.push({
      feature: feature.replace(/`[^`]*`/g, "").replace(/\s+/g, " ").trim(),
      sources: [...feature.matchAll(/`([^`]+)`/g)].map((m) => m[1]),
      tests: [...coverage.matchAll(/`([^`]+)`\s+"([^"]+)"/g)].map((m) => ({
        file: m[1],
        name: m[2],
      })),
      notCovered: coverage === "non coperto",
    });
  }
  return rows;
}

function listFiles(dir: string, accept: (path: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (accept(relative(ROOT, full).split("\\").join("/"))) {
        out.push(relative(ROOT, full).split("\\").join("/"));
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** Source files that must appear in the matrix. */
function requiredSources(): string[] {
  const direct = (dir: string) =>
    listFiles(join(ROOT, dir), (p) => p.endsWith(".ts") && p.split("/").length === dir.split("/").length + 1);
  return [
    ...listFiles(join(ROOT, "src/app"), (p) => /(^|\/)(route\.ts|page\.tsx)$/.test(p)),
    ...direct("src/db/platform"),
    ...direct("src/db/tenant-scope"),
    ...(existsSync(join(ROOT, "src/db/entitlements.ts")) ? ["src/db/entitlements.ts"] : []),
    ...listFiles(join(ROOT, "src/lib"), (p) => p.endsWith(".ts")),
  ].sort();
}

/** Returns one message per problem found in the matrix; empty when it is sound. */
function checkMatrix(markdown: string, required: string[]): string[] {
  const rows = parseMatrix(markdown);
  const problems: string[] = [];

  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.feature)) problems.push(`Duplicate row in ${MATRIX_PATH}: "${row.feature}"`);
    seen.add(row.feature);
    if (row.tests.length === 0 && !row.notCovered) {
      problems.push(`Row "${row.feature}" cites no test and is not marked "non coperto"`);
    }
  }

  const listed = new Set(rows.flatMap((row) => row.sources));
  for (const file of required) {
    if (!listed.has(file)) problems.push(`${file} is missing from ${MATRIX_PATH}`);
  }
  for (const file of listed) {
    if (!existsSync(join(ROOT, file))) {
      problems.push(`${file} is cited in ${MATRIX_PATH} but does not exist`);
    }
  }

  for (const { feature, tests } of rows.map((r) => ({ feature: r.feature, tests: r.tests }))) {
    for (const { file, name } of tests) {
      const path = join(ROOT, file);
      if (!existsSync(path)) {
        problems.push(`Test file ${file} (row "${feature}") does not exist`);
      } else if (!readFileSync(path, "utf8").includes(name)) {
        problems.push(`Test "${name}" (row "${feature}") not found in ${file}`);
      }
    }
  }
  return problems;
}

const matrix = readFileSync(join(ROOT, MATRIX_PATH), "utf8");

describe("regression matrix", () => {
  it("is sound: every cited test exists and every source module is listed", () => {
    expect(checkMatrix(matrix, requiredSources())).toEqual([]);
  });

  it("requires at least the known entry points, so the file listing cannot pass on nothing", () => {
    const required = requiredSources();
    for (const file of [
      "src/app/api/route.ts",
      "src/app/api/health/route.ts",
      "src/app/page.tsx",
      "src/db/entitlements.ts",
      "src/db/platform/tenants.ts",
      "src/db/tenant-scope/users.ts",
      "src/lib/hateoas.ts",
      "src/lib/validation/email.ts",
    ]) {
      expect(required).toContain(file);
    }
  });

  it("fails naming the file when its row is removed", () => {
    for (const file of requiredSources()) {
      const without = matrix
        .split("\n")
        .filter((line) => !(line.startsWith("|") && line.split("|")[1].includes(`\`${file}\``)))
        .join("\n");
      const problems = checkMatrix(without, requiredSources());
      expect(problems.some((p) => p.includes(file) && p.includes("missing")), file).toBe(true);
    }
  });

  it("fails when a new source module is not in the matrix", () => {
    const problems = checkMatrix(matrix, [...requiredSources(), "src/lib/new-module.ts"]);
    expect(problems).toEqual([`src/lib/new-module.ts is missing from ${MATRIX_PATH}`]);
  });

  it("fails when a cited test file was renamed", () => {
    const renamed = matrix.replace("tests/unit/hateoas.test.ts", "tests/unit/renamed.test.ts");
    const problems = checkMatrix(renamed, requiredSources());
    expect(problems.some((p) => p.includes("tests/unit/renamed.test.ts"))).toBe(true);
  });

  it("fails when a cited test name is not in its file (literal search)", () => {
    const edited = matrix.replace("includes only the allowed links", "includes only the (allowed) links.*");
    const problems = checkMatrix(edited, requiredSources());
    expect(problems.some((p) => p.includes("includes only the (allowed) links.*"))).toBe(true);
  });

  it("fails on a duplicate row and on a row with no test that is not marked non coperto", () => {
    const row = "| Helper HATEOAS `src/lib/hateoas.ts` | no | `tests/unit/hateoas.test.ts` \"requires a self link\" |";
    const duplicated = `${matrix}\n${row}\n${row}\n`;
    expect(checkMatrix(duplicated, requiredSources()).some((p) => p.startsWith("Duplicate row"))).toBe(true);
    const empty = `${matrix}\n| Funzione senza test | no | |\n`;
    expect(checkMatrix(empty, requiredSources()).some((p) => p.includes("Funzione senza test"))).toBe(true);
  });
});
