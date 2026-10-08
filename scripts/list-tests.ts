import { parseArgs } from "node:util";
import { listTests, ToolError } from "./lib/test-list";

try {
  const { values } = parseArgs({ options: { root: { type: "string" } }, strict: true });
  const tests = listTests(values.root ?? process.cwd());
  if (tests.length === 0) throw new ToolError("no tests found");
  process.stdout.write(`${JSON.stringify(tests, null, 2)}\n`);
} catch (error) {
  console.error(`list-tests: ${(error as Error).message}`);
  process.exitCode = 2;
}
