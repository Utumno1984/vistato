import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseFatturaPA } from "@/lib/fatturapa/parse";

const root = join(import.meta.dirname, "..", "..");
const example = readFileSync(join(root, "public", "esempi", "fattura-esempio.xml"));
const fixture = readFileSync(join(root, "tests", "fixtures", "fatturapa", "valid-prefix-p.xml"));

describe("public invoice example", () => {
  it("is byte for byte the valid-prefix-p fixture", () => {
    expect(example.equals(fixture)).toBe(true);
  });

  it("is accepted by the FatturaPA parser", () => {
    expect(parseFatturaPA(example).ok).toBe(true);
  });
});
