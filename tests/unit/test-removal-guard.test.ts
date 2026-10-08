import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCheckRemoval } from "../../scripts/lib/check-removal";
import {
  compareTestLists,
  parsePlaywrightList,
  parseVitestList,
  validateExemption,
  type TestEntry,
} from "../../scripts/lib/test-list";

const repo = resolve(__dirname, "../..");
const fixture = (name: string) => readFileSync(join(repo, "tests/fixtures/test-lists", name), "utf8");

const t = (file: string, name: string, runner: TestEntry["runner"] = "vitest", project = "unit"): TestEntry => ({
  runner,
  project,
  file,
  name,
});

describe("parseVitestList", () => {
  const entries = parseVitestList(fixture("vitest-list.json"), "/repo");

  it("turns every item into one entry, relative to the root, without locations", () => {
    expect(entries).toHaveLength(5);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(["file", "name", "project", "runner"]);
      expect(entry.file.startsWith("/")).toBe(false);
      expect(entry.runner).toBe("vitest");
    }
    expect(entries.map((e) => e.file)).toContain("tests/integration/db-health.test.ts");
  });

  it("keeps %s, %j and ${} literal in names", () => {
    const names = entries.map((e) => e.name);
    expect(names).toContain("emailSchema > accepts %s unchanged");
    expect(names).toContain("emailSchema > rejects the malformed address %j");
    expect(names).toContain("emailSchema > accepts ${EMAIL_MAX_LENGTH} characters and rejects one more");
  });

  it("is sorted deterministically", () => {
    const shuffled = JSON.parse(fixture("vitest-list.json")).reverse();
    expect(parseVitestList(shuffled, "/repo")).toEqual(entries);
  });

  it("rejects malformed input", () => {
    expect(() => parseVitestList("{not json", "/repo")).toThrow(/malformed JSON/);
    expect(() => parseVitestList("{}", "/repo")).toThrow(/array/);
    expect(() => parseVitestList([{ name: 1 }], "/repo")).toThrow(/invalid item/);
  });

  it("rejects files outside of the root", () => {
    expect(() => parseVitestList([{ name: "x", file: "/elsewhere/a.test.ts", projectName: "u" }], "/repo")).toThrow(
      /outside/,
    );
  });
});

describe("parsePlaywrightList", () => {
  const entries = parsePlaywrightList(fixture("playwright-list.json"), "/repo");
  const find = (name: string) => entries.filter((e) => e.name === name);

  it("uses the full title path (describe > test) as name", () => {
    expect(find("Invoice list > shows the empty state")).toHaveLength(1);
    expect(find("Invoice list > filters > by supplier")).toHaveLength(1);
    expect(find("home page renders")).toHaveLength(2);
  });

  it("uses the Playwright project, and counts the same test once per project", () => {
    expect(find("home page renders").map((e) => e.project)).toEqual(["chromium", "firefox"]);
    expect(find("Invoice list > filters > by supplier")[0].project).toBe("chromium");
  });

  it("makes files relative to the repository root, not to testDir", () => {
    expect(find("Invoice list > filters > by supplier")[0].file).toBe("e2e/invoices/list.spec.ts");
    expect(find("home page renders")[0].file).toBe("e2e/smoke.spec.ts");
  });

  it("fails when the report contains errors or is malformed", () => {
    const withErrors = { ...JSON.parse(fixture("playwright-list.json")), errors: [{ message: "boom" }] };
    expect(() => parsePlaywrightList(withErrors, "/repo")).toThrow(/boom/);
    expect(() => parsePlaywrightList("nope", "/repo")).toThrow(/malformed JSON/);
    expect(() => parsePlaywrightList({}, "/repo")).toThrow(/unexpected/);
  });
});

describe("compareTestLists", () => {
  const a = t("tests/unit/a.test.ts", "does a");
  const b = t("tests/unit/a.test.ts", "does b");

  it("reports nothing for identical lists and for added tests", () => {
    expect(compareTestLists([a, b], [b, a]).missing).toEqual([]);
    expect(compareTestLists([a], [a, b]).missing).toEqual([]);
  });

  it("reports a removed test", () => {
    expect(compareTestLists([a, b], [a]).missing).toEqual([b]);
  });

  it("reports a renamed test as missing under its old name", () => {
    expect(compareTestLists([a], [t("tests/unit/a.test.ts", "does a, renamed")]).missing).toEqual([a]);
  });

  it("reports a test moved to another file", () => {
    expect(compareTestLists([a], [t("tests/unit/other.test.ts", "does a")]).missing).toEqual([a]);
  });

  it("compares by count, not by set", () => {
    expect(compareTestLists([a, a], [a]).missing).toEqual([a]);
    expect(compareTestLists([a, a], [a, a]).missing).toEqual([]);
  });

  it("distinguishes projects and runners", () => {
    const e1 = t("e2e/s.spec.ts", "x", "playwright", "chromium");
    const e2 = t("e2e/s.spec.ts", "x", "playwright", "firefox");
    expect(compareTestLists([e1, e2], [e1]).missing).toEqual([e2]);
  });

  it("handles a removed file, and an added plus a removed file with the same total", () => {
    const f2 = t("tests/unit/gone.test.ts", "g1");
    const f3 = t("tests/unit/gone.test.ts", "g2");
    expect(compareTestLists([a, f2, f3], [a]).missing).toEqual([f2, f3]);
    expect(compareTestLists([a, f2], [a, t("tests/unit/new.test.ts", "g1")]).missing).toEqual([f2]);
  });

  it("handles unicode, quotes and newlines in names", () => {
    const odd = t("tests/unit/a.test.ts", 'accetta "è" ✓\nsecond line');
    expect(compareTestLists([odd], [odd]).missing).toEqual([]);
    expect(compareTestLists([odd], [a]).missing).toEqual([odd]);
  });

  it("does not confuse ids whose parts shift between fields", () => {
    const x = t("a", "b c");
    const y = { ...t("a b", "c") };
    expect(compareTestLists([x], [y]).missing).toEqual([x]);
  });
});

describe("validateExemption", () => {
  const justification = "The export feature was replaced by the new reporting module.";
  const body = (text: string) => `## Summary\nstuff\n\n## Rimozione funzionalità\n${text}\n`;
  const label = ["rimozione-funzionalita"];

  it("is valid with label and a real section", () => {
    expect(validateExemption({ labels: label, body: body(justification) })).toEqual({ valid: true, problems: [] });
  });

  it("requires the label", () => {
    const result = validateExemption({ labels: ["other"], body: body(justification) });
    expect(result.valid).toBe(false);
    expect(result.problems.join()).toMatch(/label/);
  });

  it("requires the section", () => {
    const result = validateExemption({ labels: label, body: "## Summary\nsomething long enough to look like text" });
    expect(result.valid).toBe(false);
    expect(result.problems.join()).toMatch(/missing section/);
  });

  it.each([
    ["empty", ""],
    ["spaces only", "   \n  \n"],
    ["only an HTML comment", "<!-- Explain which feature is removed and why, in detail please -->"],
    ["multi-line comment", "<!--\nExplain which feature is removed\nand why, in detail please\n-->"],
    ["placeholder", "..."],
    ["too short", "Not needed anymore."],
  ])("rejects a %s section", (_, text) => {
    const result = validateExemption({ labels: label, body: body(text) });
    expect(result.valid).toBe(false);
    expect(result.problems.join()).toMatch(/30 characters/);
  });

  it.each([
    ["template sub-headings only", "### What is removed\n### Why\n### Replacement or migration path\n### Who was told"],
    ["a repeated bulleted TODO", "- TODO\n- TODO\n- TODO\n- TODO\n- TODO\n- TODO\n- TODO\n- TODO"],
    ["numbered and quoted placeholders", "1. TBD\n2. TBD\n> N/A\n> > ...\n+ xxx\n* ..."],
    ["30 zero-width spaces", "​".repeat(30)],
    ["zero-width spaces between placeholders", "TODO​\n-​ TODO​\n".repeat(10)],
    ["30 punctuation marks and symbols", "!?.,;:!?.,;:!?.,;:!?.,;:!?.,;:!?.,;:"],
    ["headings and list markers around too little text", "### Why\n- ok\n- fine"],
  ])("rejects %s", (_, text) => {
    const result = validateExemption({ labels: label, body: body(text) });
    expect(result.valid).toBe(false);
    expect(result.problems.join()).toMatch(/30 characters/);
  });

  it("accepts real text under sub-headings and list markers, counting only letters and digits", () => {
    const text = "### Why\n- The export screen is replaced\n- by the new report 2.0 module";
    expect(validateExemption({ labels: label, body: body(text) }).valid).toBe(true);
    // 29 letters/digits spread over punctuation and a zero-width space: still too short.
    const short = "- abcdefghij, klmnopqrst; uvwxy​zabc !!!!!!!!!!";
    expect(validateExemption({ labels: label, body: body(short) }).valid).toBe(false);
  });

  it("does not count comment text towards the 30 characters", () => {
    const text = `Short.\n<!-- ${"x".repeat(100)} -->`;
    expect(validateExemption({ labels: label, body: body(text) }).valid).toBe(false);
  });

  it.each([null, undefined, ""])("fails safely for body %j", (value) => {
    const result = validateExemption({ labels: label, body: value });
    expect(result.valid).toBe(false);
  });

  it("accepts CRLF line endings", () => {
    const crlf = body(justification).replace(/\n/g, "\r\n");
    expect(validateExemption({ labels: label, body: crlf }).valid).toBe(true);
  });

  it("accepts upper case, extra spaces, and a missing accent in the heading", () => {
    for (const heading of ["## RIMOZIONE FUNZIONALITÀ", "##   Rimozione   funzionalità  ", "## Rimozione funzionalita"]) {
      expect(validateExemption({ labels: label, body: `${heading}\n${justification}` }).valid).toBe(true);
    }
  });

  it("stops the section at the next heading", () => {
    const text = `## Rimozione funzionalità\nshort\n## Other\n${justification}`;
    expect(validateExemption({ labels: label, body: text }).valid).toBe(false);
  });

  it("ignores a section that is only inside a comment", () => {
    const text = `<!--\n## Rimozione funzionalità\n${justification}\n-->`;
    const result = validateExemption({ labels: label, body: text });
    expect(result.valid).toBe(false);
    expect(result.problems.join()).toMatch(/missing section/);
  });

  it("matches the label case-insensitively but exactly", () => {
    expect(validateExemption({ labels: ["Rimozione-Funzionalita"], body: body(justification) }).valid).toBe(true);
    expect(validateExemption({ labels: ["rimozione-funzionalita-x"], body: body(justification) }).valid).toBe(false);
  });
});

describe("check-test-removal CLI", () => {
  let dir: string;
  const write = (name: string, content: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
    return path;
  };
  const run = (args: string[]) => {
    const result = spawnSync(join(repo, "node_modules/.bin/tsx"), [join(repo, "scripts/check-test-removal.ts"), ...args], {
      encoding: "utf8",
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const a = t("tests/unit/a.test.ts", "does a");
  const b = t("tests/unit/a.test.ts", "does b");
  const justification = "The export feature was replaced by the new reporting module.";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "guard-test-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("exits 0 for identical lists", () => {
    const base = write("same-base.json", [a, b]);
    expect(run(["--base", base, "--head", base]).code).toBe(0);
  });

  it("exits 0 when tests are only added", () => {
    const base = write("add-base.json", [a]);
    const head = write("add-head.json", [a, b]);
    expect(run(["--base", base, "--head", head]).code).toBe(0);
  });

  it("exits 1 with an ::error annotation naming runner, file and test", () => {
    const base = write("rm-base.json", [a, b]);
    const head = write("rm-head.json", [a]);
    const result = run(["--base", base, "--head", head]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("::error");
    expect(result.stdout).toContain("vitest");
    expect(result.stdout).toContain("tests/unit/a.test.ts");
    expect(result.stdout).toContain("does b");
  });

  it("exits 0 with warnings when label and section are valid", () => {
    const base = write("ex-base.json", [a, b]);
    const head = write("ex-head.json", [a]);
    const bodyFile = write("ex-body.md", `## Rimozione funzionalità\n${justification}`);
    const result = run(["--base", base, "--head", head, "--labels", '["rimozione-funzionalita"]', "--body-file", bodyFile]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("::warning");
    expect(result.stdout).toContain("does b");
  });

  it("accepts labels from a gh-style JSON file and from a comma separated string", () => {
    const base = write("lb-base.json", [a, b]);
    const head = write("lb-head.json", [a]);
    const bodyFile = write("lb-body.md", `## Rimozione funzionalità\n${justification}`);
    const labelsFile = write("labels.json", [{ name: "bug" }, { name: "rimozione-funzionalita" }]);
    const ghFile = write("labels-gh.json", { labels: [{ name: "rimozione-funzionalita" }] });
    expect(run(["--base", base, "--head", head, "--labels-file", labelsFile, "--body-file", bodyFile]).code).toBe(0);
    expect(run(["--base", base, "--head", head, "--labels-file", ghFile, "--body-file", bodyFile]).code).toBe(0);
    expect(run(["--base", base, "--head", head, "--labels", "bug, rimozione-funzionalita", "--body-file", bodyFile]).code).toBe(0);
  });

  it("does not read --labels as a file name, even when such a file exists", () => {
    const base = write("lbn-base.json", [a, b]);
    const head = write("lbn-head.json", [a]);
    const bodyFile = write("lbn-body.md", `## Rimozione funzionalità\n${justification}`);
    const labelsFile = write("rimozione-funzionalita", [{ name: "rimozione-funzionalita" }]);
    // The string equals an existing file name, but it is a label: the label list is just that name.
    expect(run(["--base", base, "--head", head, "--labels", labelsFile, "--body-file", bodyFile]).code).toBe(1);
    expect(run(["--base", base, "--head", head, "--labels", "x", "--labels-file", labelsFile]).code).toBe(2);
  });

  it("exits 2 for an unreadable --labels-file and for malformed labels JSON", () => {
    const base = write("lbe-base.json", [a, b]);
    const head = write("lbe-head.json", [a]);
    expect(run(["--base", base, "--head", head, "--labels-file", join(dir, "nope.json")]).code).toBe(2);
    expect(run(["--base", base, "--head", head, "--labels", '{"labels": oops']).code).toBe(2);
  });

  it("exits 1 saying the section is missing when only the label is present", () => {
    const base = write("nosec-base.json", [a, b]);
    const head = write("nosec-head.json", [a]);
    const emptyBody = write("nosec-body.md", "## Rimozione funzionalità\n<!-- explain -->\n");
    const result = run(["--base", base, "--head", head, "--labels", "rimozione-funzionalita", "--body-file", emptyBody]);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/30 characters/);
    const noBody = run(["--base", base, "--head", head, "--labels", "rimozione-funzionalita"]);
    expect(noBody.code).toBe(1);
    expect(noBody.stdout).toMatch(/missing section/);
  });

  it("exits 1 saying the label is missing when only the section is present", () => {
    const base = write("nolabel-base.json", [a, b]);
    const head = write("nolabel-head.json", [a]);
    const bodyFile = write("nolabel-body.md", `## Rimozione funzionalità\n${justification}`);
    const result = run(["--base", base, "--head", head, "--body-file", bodyFile]);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/missing label/);
  });

  it("truncates the list to 50 items with the total count", () => {
    const many = Array.from({ length: 120 }, (_, i) => t("tests/unit/many.test.ts", `case ${i}`));
    const base = write("many-base.json", [a, ...many]);
    const head = write("many-head.json", [a]);
    const result = run(["--base", base, "--head", head]);
    expect(result.code).toBe(1);
    expect(result.stdout.match(/::error/g)).toHaveLength(50);
    expect(result.stdout).toContain("120 test(s)");
    expect(result.stdout).toContain("70 more (120 in total)");
  });

  it("escapes newlines in names so an annotation stays on one line", () => {
    const odd = t("tests/unit/a.test.ts", "line one\nline two");
    const base = write("nl-base.json", [a, odd]);
    const head = write("nl-head.json", [a]);
    const result = run(["--base", base, "--head", head]);
    expect(result.code).toBe(1);
    const errorLines = result.stdout.split("\n").filter((l) => l.startsWith("::error"));
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain("line one");
    expect(errorLines[0]).toContain("line two");
  });

  it.each([
    ["empty base", "[]", "head"],
    ["empty head", "head", "[]"],
    ["malformed base", "{oops", "head"],
    ["malformed head", "head", "{oops"],
    ["non-array head", "head", '{"a":1}'],
  ])("exits 2 for %s", (_, baseContent, headContent) => {
    const good = JSON.stringify([a]);
    const base = write("bad-base.json", baseContent === "head" ? good : baseContent);
    const head = write("bad-head.json", headContent === "head" ? good : headContent);
    const result = run(["--base", base, "--head", head]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("check-test-removal");
  });

  it("exits 2 when a file is missing or arguments are wrong", () => {
    const base = write("miss-base.json", [a]);
    expect(run(["--base", base, "--head", join(dir, "does-not-exist.json")]).code).toBe(2);
    expect(run(["--base", base]).code).toBe(2);
    expect(run(["--bogus"]).code).toBe(2);
  });

  it("works in-process with injected output", () => {
    const base = write("inproc-base.json", [a, b]);
    const head = write("inproc-head.json", [a]);
    const lines: string[] = [];
    const code = runCheckRemoval(["--base", base, "--head", head], { log: (l) => lines.push(l), error: (l) => lines.push(l) });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("does b");
  });
});

describe("test-guard script", () => {
  const run = (args: string[]) => {
    const result = spawnSync(join(repo, "node_modules/.bin/tsx"), [join(repo, "scripts/test-guard.ts"), ...args], {
      encoding: "utf8",
      cwd: repo,
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const worktrees = () =>
    spawnSync("git", ["worktree", "list", "--porcelain"], { encoding: "utf8", cwd: repo }).stdout;

  it("refuses a --base-ref that looks like an option", () => {
    const result = run(["--base-ref=--detach"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/invalid --base-ref/);
  });

  it("exits 2 for an unknown ref and leaves no worktree behind", () => {
    const before = worktrees();
    const result = run(["--base-ref", "no-such-ref-for-the-guard"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/unknown --base-ref/);
    expect(worktrees()).toBe(before);
  });
});

describe("list-tests CLI", () => {
  const run = (args: string[]) => {
    const result = spawnSync(join(repo, "node_modules/.bin/tsx"), [join(repo, "scripts/list-tests.ts"), ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  it("prints sorted JSON with relative files, no locations and no absolute paths", () => {
    const result = run(["--root", repo]);
    expect(result.code).toBe(0);
    const tests = JSON.parse(result.stdout) as TestEntry[];
    expect(tests.length).toBeGreaterThan(0);
    expect(tests.some((x) => x.runner === "playwright")).toBe(true);
    expect(tests.some((x) => x.runner === "vitest")).toBe(true);
    for (const entry of tests) {
      expect(Object.keys(entry).sort()).toEqual(["file", "name", "project", "runner"]);
      expect(entry.file.startsWith("/")).toBe(false);
    }
    expect(result.stdout).not.toContain(repo);
    expect(result.stdout).not.toContain('"location"');
    // The test list includes this very file: the guard guards itself.
    expect(tests.some((x) => x.file === "tests/unit/test-removal-guard.test.ts")).toBe(true);
    // The static parser of Vitest invents tests from calls such as `testSql()(row)` or
    // `tests.some((x) => ...)`; the real collection must not contain them.
    const names = tests.filter((x) => x.runner === "vitest").map((x) => x.name);
    expect(names).not.toContain("row");
    expect(names.filter((name) => name.includes("=>"))).toEqual([]);
    // Parametrized names are expanded by the real collection.
    expect(names).toContain("emailSchema > accepts mario@acme.it unchanged");
    const keys = tests.map((x) => [x.runner, x.project, x.file, x.name].join("\u0000"));
    expect(keys).toEqual([...keys].sort());
  }, 60_000);

  it("exits 2 with the stderr of the failing command", () => {
    const empty = mkdtempSync(join(tmpdir(), "guard-empty-"));
    try {
      const result = run(["--root", empty]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("list-tests:");
      expect(result.stderr).toMatch(/exited with/);
      expect(result.stdout).toBe("");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }, 60_000);
});
