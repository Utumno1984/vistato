import { describe, expect, it } from "vitest";

import { firstDroppedFile } from "@/lib/invoices/dropped-file";

const f = (name: string) => new File(["x"], name);

describe("firstDroppedFile", () => {
  it("returns the first of several files", () => {
    expect(firstDroppedFile([f("a.xml"), f("b.xml")])?.name).toBe("a.xml");
  });
  it("returns null for an empty or missing list (non-file items)", () => {
    expect(firstDroppedFile([])).toBeNull();
    expect(firstDroppedFile(null)).toBeNull();
    expect(firstDroppedFile(undefined)).toBeNull();
  });
  it("returns null when the first entry is not a File", () => {
    expect(firstDroppedFile([{ name: "x" } as unknown as File])).toBeNull();
  });
});
