import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  compareTestLists,
  parseTestListFile,
  REMOVAL_LABEL,
  ToolError,
  validateExemption,
  type TestEntry,
} from "./test-list";

export const MAX_LISTED = 50;

/** Escapes a value for a GitHub Actions workflow command message. */
function escapeCommand(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

function describe(entry: TestEntry): string {
  // JSON.stringify keeps newlines and quotes in names visible and on one line.
  return `[${entry.runner}${entry.project ? `/${entry.project}` : ""}] ${entry.file} :: ${JSON.stringify(entry.name)}`;
}

/** Accepts a JSON file, a JSON array, or a comma separated string. Items may be strings or {name}. */
export function parseLabels(value: string | undefined): string[] {
  if (value === undefined) return [];
  let text = value;
  if (existsSync(value)) text = readFileSync(value, "utf8");
  const trimmed = text.trim();
  if (trimmed === "") return [];
  if (trimmed.startsWith("[")) {
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch (error) {
      throw new ToolError(`--labels: malformed JSON (${(error as Error).message})`);
    }
    if (!Array.isArray(data)) throw new ToolError("--labels: expected a JSON array");
    return data.map((item) => {
      if (typeof item === "string") return item;
      if (typeof item === "object" && item !== null && typeof (item as { name?: unknown }).name === "string") {
        return (item as { name: string }).name;
      }
      throw new ToolError("--labels: items must be strings or objects with a name");
    });
  }
  return trimmed.split(",").map((label) => label.trim()).filter(Boolean);
}

function readFileOrFail(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new ToolError(`${what}: cannot read ${path} (${(error as Error).message})`);
  }
}

type Output = { log: (line: string) => void; error: (line: string) => void };

/** Returns the exit code: 0 ok or exempt, 1 tests missing, 2 tool error. */
export function runCheckRemoval(argv: string[], out: Output = console): number {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        base: { type: "string" },
        head: { type: "string" },
        labels: { type: "string" },
        "body-file": { type: "string" },
      },
      strict: true,
    });
    if (!values.base || !values.head) throw new ToolError("usage: --base <file> --head <file> [--labels <file|string>] [--body-file <path>]");

    const base = parseTestListFile(readFileOrFail(values.base, "base list"), "base list");
    const head = parseTestListFile(readFileOrFail(values.head, "head list"), "head list");
    const { missing } = compareTestLists(base, head);

    if (missing.length === 0) {
      out.log(`OK: no test removed (${base.length} in base, ${head.length} in head).`);
      return 0;
    }

    const shown = missing.slice(0, MAX_LISTED);
    const listing = (level: "error" | "warning"): void => {
      for (const entry of shown) {
        out.log(`::${level} title=Test removed::${escapeCommand(describe(entry))}`);
      }
      if (missing.length > shown.length) {
        out.log(`... and ${missing.length - shown.length} more (${missing.length} in total).`);
      }
    };

    const labels = parseLabels(values.labels);
    const body = values["body-file"] ? readFileOrFail(values["body-file"], "PR body") : null;
    const exemption = validateExemption({ labels, body });

    if (exemption.valid) {
      out.log(`WARNING: ${missing.length} test(s) removed or renamed, exempted by label "${REMOVAL_LABEL}" and PR justification.`);
      listing("warning");
      return 0;
    }

    out.log(`FAIL: ${missing.length} test(s) present in base are missing in head.`);
    listing("error");
    out.log("To remove tests on purpose, the PR needs:");
    for (const problem of exemption.problems) out.log(`  - ${problem}`);
    return 1;
  } catch (error) {
    out.error(`check-test-removal: ${(error as Error).message}`);
    return 2;
  }
}
