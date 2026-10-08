import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runCheckRemoval } from "./lib/check-removal";
import { listTests, ToolError } from "./lib/test-list";

/** Local run of the guard: lists the tests at `--base-ref` (temporary worktree) and at HEAD. */
function main(): number {
  const { values } = parseArgs({
    options: {
      "base-ref": { type: "string", default: "origin/main" },
      labels: { type: "string" },
      "body-file": { type: "string" },
    },
    strict: true,
  });
  const repo = resolve(process.cwd());
  const tmp = mkdtempSync(join(tmpdir(), "test-guard-"));
  const worktree = join(tmp, "base");
  try {
    execFileSync("git", ["worktree", "add", "--detach", worktree, values["base-ref"]!], {
      cwd: repo,
      stdio: ["ignore", "ignore", "inherit"],
    });
    // Same dependencies as the working copy, so the base configuration can be loaded.
    symlinkSync(join(repo, "node_modules"), join(worktree, "node_modules"), "dir");
    const baseFile = join(tmp, "base.json");
    const headFile = join(tmp, "head.json");
    writeFileSync(baseFile, JSON.stringify(listTests(worktree)));
    writeFileSync(headFile, JSON.stringify(listTests(repo)));
    const args = ["--base", baseFile, "--head", headFile];
    if (values.labels !== undefined) args.push("--labels", values.labels);
    if (values["body-file"]) args.push("--body-file", values["body-file"]);
    return runCheckRemoval(args);
  } catch (error) {
    console.error(`test-guard: ${error instanceof ToolError ? error.message : (error as Error).message}`);
    return 2;
  } finally {
    try {
      execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: repo, stdio: "ignore" });
    } catch {
      // The worktree may not have been created.
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

process.exitCode = main();
