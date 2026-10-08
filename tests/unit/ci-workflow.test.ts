import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");

/** Text of the top-level job `name` (up to the next job or end of file). */
function jobBlock(name: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[\w-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("ci workflow: test-guard job", () => {
  const job = jobBlock("test-guard");

  it("exists", () => {
    expect(job).not.toBe("");
  });

  it("has no Postgres service, a timeout and minimal permissions", () => {
    expect(job).not.toContain("services:");
    expect(job).not.toContain("DATABASE_URL");
    expect(job).toMatch(/timeout-minutes: \d+/);
    expect(job).toMatch(/permissions:\n\s+contents: read\n\s+pull-requests: read\n/);
    expect(job).not.toMatch(/write/);
  });

  it("checks out the full history", () => {
    expect(job).toMatch(/fetch-depth: 0/);
  });

  it("uses the merge-base and a worktree, not HEAD~1", () => {
    expect(job).toContain("git merge-base");
    expect(job).toContain("git worktree add");
    expect(job).not.toContain("HEAD~1");
  });

  it("never interpolates the PR body (or other untrusted text) in the workflow", () => {
    expect(workflow).not.toMatch(/\$\{\{\s*github\.event\.pull_request\.body/);
    expect(workflow).not.toMatch(/\$\{\{\s*github\.event\.pull_request\.title/);
    expect(workflow).not.toMatch(/\$\{\{\s*github\.head_ref/);
  });

  it("reads labels and body at run time and passes them as files", () => {
    expect(job).toContain("gh api");
    expect(job).toContain("--labels-file");
    expect(job).toContain("--body-file");
  });

  it("does not use pull_request_target or secrets", () => {
    expect(workflow).not.toContain("pull_request_target");
    expect(job).not.toContain("secrets.");
  });

  it("skips with a message on push", () => {
    expect(job).toContain("guardia saltata: già applicata sulla PR");
  });

  it("does not add labeled/edited triggers (they would cancel a running check)", () => {
    expect(workflow).not.toMatch(/types:\s*\[[^\]]*(labeled|edited)/);
  });
});

describe("pull request template", () => {
  const template = readFileSync(join(root, ".github/pull_request_template.md"), "utf8");

  it("has the removal section with an HTML comment and the quality gate item", () => {
    expect(template).toContain("## Rimozione funzionalità");
    expect(template).toContain(
      "<!-- compilare solo con l'etichetta rimozione-funzionalita: cosa si rimuove e perché -->",
    );
    expect(template).toContain("Nessun test rimosso o rinominato (job test-guard verde)");
  });
});
