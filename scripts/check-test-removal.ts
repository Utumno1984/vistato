import { runCheckRemoval } from "./lib/check-removal";

process.exitCode = runCheckRemoval(process.argv.slice(2));
