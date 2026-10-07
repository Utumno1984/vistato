import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MIGRATIONS_FOLDER, requireTestDatabaseUrl } from "@/db/migrate";

describe("requireTestDatabaseUrl", () => {
  it("returns TEST_DATABASE_URL when set", () => {
    expect(requireTestDatabaseUrl({ TEST_DATABASE_URL: "postgres://x@h/vistato_test" })).toBe(
      "postgres://x@h/vistato_test",
    );
  });

  it.each([{}, { TEST_DATABASE_URL: "" }, { TEST_DATABASE_URL: "   " }])(
    "throws when missing or blank (%j), even if DATABASE_URL is set",
    (env) => {
      expect(() =>
        requireTestDatabaseUrl({ ...env, DATABASE_URL: "postgres://x@h/vistato" }),
      ).toThrow(/TEST_DATABASE_URL/);
    },
  );
});

describe("MIGRATIONS_FOLDER", () => {
  it("points to drizzle/ at the repository root", () => {
    expect(MIGRATIONS_FOLDER).toBe(path.resolve(__dirname, "../../drizzle"));
    expect(existsSync(path.join(MIGRATIONS_FOLDER, "meta/_journal.json"))).toBe(true);
  });
});
