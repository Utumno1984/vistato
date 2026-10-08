import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** One test, identified by runner + project + file + full name. */
export type TestEntry = {
  runner: "vitest" | "playwright";
  project: string;
  /** Relative to the repository root, with forward slashes. */
  file: string;
  name: string;
};

/** Thrown for tool errors (malformed input, failing list command): the CLI exits with 2. */
export class ToolError extends Error {}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ToolError(`${what}: malformed JSON (${(error as Error).message})`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Path relative to `root`, never absolute and never outside of it. */
export function relativeFile(root: string, file: string): string {
  const absolute = resolve(root, file);
  const rel = relative(resolve(root), absolute).split("\\").join("/");
  if (rel === "" || rel.startsWith("../") || rel === ".." || isAbsolute(rel)) {
    throw new ToolError(`test file outside of the root: ${file}`);
  }
  return rel;
}

/** Deterministic order (code points, not locale) so the output is stable across machines. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortEntries(entries: TestEntry[]): TestEntry[] {
  return [...entries].sort(
    (a, b) =>
      compareStrings(a.runner, b.runner) ||
      compareStrings(a.project, b.project) ||
      compareStrings(a.file, b.file) ||
      compareStrings(a.name, b.name),
  );
}

/**
 * Normalizes the output of `vitest list --json`. Names are kept literal: `%s`, `%j` and
 * `${...}` of test.each templates are not interpolated.
 */
export function parseVitestList(input: string | unknown, root: string): TestEntry[] {
  const data = typeof input === "string" ? parseJson(input, "vitest list") : input;
  if (!Array.isArray(data)) throw new ToolError("vitest list: expected a JSON array");
  const entries = data.map((item, index): TestEntry => {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.file !== "string") {
      throw new ToolError(`vitest list: invalid item at index ${index}`);
    }
    const project = typeof item.projectName === "string" ? item.projectName : "";
    return {
      runner: "vitest",
      project,
      file: relativeFile(root, item.file),
      name: item.name,
    };
  });
  return sortEntries(entries);
}

type PlaywrightSuite = { title?: unknown; suites?: unknown; specs?: unknown };

/**
 * Normalizes the output of `playwright test --list --reporter=json`. The name is the full path
 * of titles (describe > nested describe > test); the file-level suite title is not part of it.
 * A spec run by N projects yields N entries.
 */
export function parsePlaywrightList(input: string | unknown, root: string): TestEntry[] {
  const data = typeof input === "string" ? parseJson(input, "playwright list") : input;
  if (!isRecord(data) || !Array.isArray(data.suites) || !isRecord(data.config)) {
    throw new ToolError("playwright list: unexpected report shape");
  }
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    const first = data.errors[0];
    const message = isRecord(first) && typeof first.message === "string" ? first.message : "";
    throw new ToolError(`playwright list: ${data.errors.length} error(s) reported. ${message}`);
  }
  const rootDir = data.config.rootDir;
  if (typeof rootDir !== "string") throw new ToolError("playwright list: missing config.rootDir");

  const entries: TestEntry[] = [];

  const visit = (suite: PlaywrightSuite, titles: string[], file: string): void => {
    if (Array.isArray(suite.specs)) {
      for (const spec of suite.specs as unknown[]) {
        if (!isRecord(spec) || typeof spec.title !== "string" || !Array.isArray(spec.tests)) {
          throw new ToolError("playwright list: invalid spec");
        }
        for (const test of spec.tests as unknown[]) {
          if (!isRecord(test) || typeof test.projectName !== "string") {
            throw new ToolError("playwright list: invalid test");
          }
          entries.push({
            runner: "playwright",
            project: test.projectName,
            file,
            name: [...titles, spec.title].join(" > "),
          });
        }
      }
    }
    if (Array.isArray(suite.suites)) {
      for (const child of suite.suites as PlaywrightSuite[]) {
        if (!isRecord(child) || typeof child.title !== "string") {
          throw new ToolError("playwright list: invalid suite");
        }
        visit(child, [...titles, child.title], file);
      }
    }
  };

  for (const fileSuite of data.suites as unknown[]) {
    if (!isRecord(fileSuite) || typeof fileSuite.file !== "string") {
      throw new ToolError("playwright list: invalid file suite");
    }
    // `file` is relative to config.rootDir (the testDir), not to the repository root.
    const file = relativeFile(root, resolve(rootDir, fileSuite.file));
    visit(fileSuite, [], file);
  }
  return sortEntries(entries);
}

function runList(command: string, args: string[], root: string): string {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    // Defence in depth: test files are imported to collect them, so make sure that nothing
    // they import can reach a database. (globalSetup is removed by the wrapper config.)
    env: { ...process.env, DATABASE_URL: "", TEST_DATABASE_URL: "" },
  });
  if (result.error) {
    throw new ToolError(`${command} ${args.join(" ")} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new ToolError(
      `${command} ${args.join(" ")} exited with ${result.status}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

const VITEST_CONFIG_NAMES = ["vitest.config", "vite.config"].flatMap((base) =>
  [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"].map((ext) => base + ext),
);

/**
 * Wrapper config that loads the repository's own config and drops every `globalSetup` (top level
 * and per project): collecting tests must not run migrations or seeds. Everything else, in
 * particular include/exclude, is kept as is.
 */
function wrapperConfigSource(baseConfigPath: string): string {
  return `import loaded from ${JSON.stringify(pathToFileURL(baseConfigPath).href)};
const strip = (config) => {
  if (!config || typeof config !== "object") return config;
  const copy = { ...config };
  if (copy.test && typeof copy.test === "object") {
    const { globalSetup, ...test } = copy.test;
    copy.test = test;
    if (Array.isArray(test.projects)) {
      copy.test.projects = test.projects.map((project) =>
        project && typeof project === "object" ? strip(project) : project,
      );
    }
  }
  return copy;
};
export default typeof loaded === "function"
  ? async (...args) => strip(await loaded(...args))
  : strip(loaded);
`;
}

function listVitest(root: string): string {
  const configName = VITEST_CONFIG_NAMES.find((name) => existsSync(join(root, name)));
  // --staticParse=false really collects the tests: the static parser invents tests from calls
  // like `foo()(row)` and misses generated ones.
  const args = ["--no-install", "vitest", "list", "--json", "--staticParse=false"];
  if (!configName) return runList("npx", args, root);
  const tmp = mkdtempSync(join(tmpdir(), "list-tests-"));
  try {
    const wrapper = join(tmp, "vitest.list.config.mjs");
    writeFileSync(wrapper, wrapperConfigSource(join(root, configName)));
    return runList("npx", [...args, "--config", wrapper, "--root", root], root);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Lists the tests of the repository in `root`, using that repository's own configuration. */
export function listTests(root: string): TestEntry[] {
  const absoluteRoot = resolve(root);
  const vitest = parseVitestList(listVitest(absoluteRoot), absoluteRoot);
  const playwright = parsePlaywrightList(
    runList("npx", ["--no-install", "playwright", "test", "--list", "--reporter=json"], absoluteRoot),
    absoluteRoot,
  );
  return sortEntries([...vitest, ...playwright]);
}

// ---------------------------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------------------------

/** The id includes runner, project and file: moving or renaming a test changes it. */
export function testId(entry: TestEntry): string {
  return JSON.stringify([entry.runner, entry.project, entry.file, entry.name]);
}

/**
 * Tests present in `base` and missing in `head`, compared by occurrence count: two identical
 * tests in base and one in head leave one missing.
 */
export function compareTestLists(base: TestEntry[], head: TestEntry[]): { missing: TestEntry[] } {
  const remaining = new Map<string, number>();
  for (const entry of head) {
    const id = testId(entry);
    remaining.set(id, (remaining.get(id) ?? 0) + 1);
  }
  const missing: TestEntry[] = [];
  for (const entry of sortEntries(base)) {
    const id = testId(entry);
    const left = remaining.get(id) ?? 0;
    if (left > 0) remaining.set(id, left - 1);
    else missing.push(entry);
  }
  return { missing };
}

/** Parses a stored test list; an empty list is a tool error, never "no test removed". */
export function parseTestListFile(text: string, what: string): TestEntry[] {
  const data = parseJson(text, what);
  if (!Array.isArray(data) || data.length === 0) {
    throw new ToolError(`${what}: expected a non-empty JSON array of tests`);
  }
  return data.map((item, index) => {
    if (
      !isRecord(item) ||
      (item.runner !== "vitest" && item.runner !== "playwright") ||
      typeof item.project !== "string" ||
      typeof item.file !== "string" ||
      typeof item.name !== "string"
    ) {
      throw new ToolError(`${what}: invalid test at index ${index}`);
    }
    return { runner: item.runner, project: item.project, file: item.file, name: item.name };
  });
}

// ---------------------------------------------------------------------------------------------
// Exemption
// ---------------------------------------------------------------------------------------------

export const REMOVAL_LABEL = "rimozione-funzionalita";
export const REMOVAL_SECTION_TITLE = "Rimozione funzionalità";
export const MIN_JUSTIFICATION_LENGTH = 30;

/** Lines that only hold template filler count as no text. */
const PLACEHOLDER_LINE = /^(?:[-*_\s]*|\.{2,}|…+|tbd|todo|n\/?a|xxx+|descrivi.*|\[.*\]|<.*>)$/i;

/** Removes list and quote markers (-, *, +, 1., 1), >), also nested, from the start of a line. */
function stripListMarkers(line: string): string {
  let current = line;
  for (;;) {
    const next = current.replace(/^(?:[-*+>]|\d+[.)])(?:\s+|$)/, "").trim();
    if (next === current) return current;
    current = next;
  }
}

/** Number of letters and digits: punctuation, spaces and symbols are not real text. */
export function countRealCharacters(text: string): number {
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

function normalizeTitle(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Text of the "## Rimozione funzionalità" section without comments and placeholders. */
export function extractRemovalJustification(body: string | null | undefined): string | null {
  if (typeof body !== "string") return null;
  const lines = body
    // Invisible format characters (zero-width space, joiners, BOM...) are never real text.
    .replace(/\p{Cf}/gu, "")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const wanted = normalizeTitle(REMOVAL_SECTION_TITLE);
  let inSection = false;
  let found = false;
  const content: string[] = [];
  for (const line of lines) {
    const heading = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t#]*$/.exec(line);
    if (heading) {
      if (inSection && heading[1].length <= 2) break;
      if (!inSection && heading[1].length === 2 && normalizeTitle(heading[2]) === wanted) {
        inSection = true;
        found = true;
        continue;
      }
    }
    if (inSection) content.push(line);
  }
  if (!found) return null;
  return content
    .map((line) => line.trim())
    // Sub-headings of the template are structure, not justification.
    .filter((line) => !/^#{1,6}(?:\s|$)/.test(line))
    .map((line) => stripListMarkers(line))
    .filter((line) => !PLACEHOLDER_LINE.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The exemption needs both the label and a real justification in the PR body. */
export function validateExemption(input: { labels: string[]; body: string | null | undefined }): {
  valid: boolean;
  problems: string[];
} {
  const problems: string[] = [];
  if (!input.labels.some((label) => label.trim().toLowerCase() === REMOVAL_LABEL)) {
    problems.push(`missing label "${REMOVAL_LABEL}"`);
  }
  const text = extractRemovalJustification(input.body);
  if (text === null) {
    problems.push(`missing section "## ${REMOVAL_SECTION_TITLE}" in the PR description`);
  } else if (countRealCharacters(text) < MIN_JUSTIFICATION_LENGTH) {
    problems.push(
      `section "## ${REMOVAL_SECTION_TITLE}" needs at least ${MIN_JUSTIFICATION_LENGTH} characters (letters or digits) of real text (comments, headings, list markers and placeholders do not count)`,
    );
  }
  return { valid: problems.length === 0, problems };
}
