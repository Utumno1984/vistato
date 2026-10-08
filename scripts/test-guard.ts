import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runCheckRemoval } from "./lib/check-removal";
import { listTests, ToolError } from "./lib/test-list";

/** Lets pending signal handlers run between the (blocking) steps. */
const tick = () => new Promise<void>((done) => setImmediate(done));

/** Local run of the guard: lists the tests at `--base-ref` (temporary worktree) and at HEAD. */
async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "base-ref": { type: "string", default: "origin/main" },
      labels: { type: "string" },
      "labels-file": { type: "string" },
      "body-file": { type: "string" },
    },
    strict: true,
  });
  const baseRef = values["base-ref"]!;
  if (baseRef === "" || baseRef.startsWith("-")) {
    throw new ToolError(`invalid --base-ref: ${JSON.stringify(baseRef)}`);
  }

  const repo = resolve(process.cwd());
  let tmp: string | undefined;
  let worktree: string | undefined;
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (worktree) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: repo, stdio: "ignore" });
      } catch {
        // The worktree may not have been created.
      }
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  try {
    // Resolve to a commit first: the ref is user input and must never be read as an option.
    const sha = execFileSync("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${baseRef}^{commit}`], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    tmp = mkdtempSync(join(tmpdir(), "test-guard-"));
    worktree = join(tmp, "base");
    await tick();
    execFileSync("git", ["worktree", "add", "--detach", worktree, sha], {
      cwd: repo,
      stdio: ["ignore", "ignore", "inherit"],
    });
    // Same dependencies as the working copy, so the base configuration can be loaded.
    symlinkSync(join(repo, "node_modules"), join(worktree, "node_modules"), "dir");
    const baseFile = join(tmp, "base.json");
    const headFile = join(tmp, "head.json");
    writeFileSync(baseFile, JSON.stringify(listTests(worktree)));
    await tick();
    writeFileSync(headFile, JSON.stringify(listTests(repo)));
    await tick();
    const args = ["--base", baseFile, "--head", headFile];
    if (values.labels !== undefined) args.push("--labels", values.labels);
    if (values["labels-file"] !== undefined) args.push("--labels-file", values["labels-file"]);
    if (values["body-file"]) args.push("--body-file", values["body-file"]);
    return runCheckRemoval(args);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    const message = (error as Error).message;
    throw new ToolError(/rev-parse/.test(message) ? `unknown --base-ref: ${baseRef}` : message);
  } finally {
    cleanup();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`test-guard: ${(error as Error).message}`);
    process.exitCode = 2;
  },
);
