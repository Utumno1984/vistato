import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertTestDatabase,
  databaseNameFromUrl,
  MIGRATIONS_FOLDER,
  requireTestDatabaseUrl,
} from "@/db/migrate";

describe("requireTestDatabaseUrl", () => {
  it("returns TEST_DATABASE_URL when set to a test database", () => {
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

  it("throws when TEST_DATABASE_URL points to a non-test database", () => {
    expect(() => requireTestDatabaseUrl({ TEST_DATABASE_URL: "postgres://x@h/vistato" })).toThrow(
      /Refusing to use database "vistato"/,
    );
  });
});

describe("databaseNameFromUrl", () => {
  it.each([
    ["postgres://u:p@localhost:5433/vistato_test", "vistato_test"],
    ["postgresql://u@h/vistato_test?sslmode=require", "vistato_test"],
    ["postgres://u@h/vistato_test?database=vistato", "vistato"],
    ["postgres://u@h1:5432,h2:5433/vistato_test", "vistato_test"],
    ["postgres://u:p%40ss@h/vistato_test", "vistato_test"],
    ["postgres://u@h", ""],
    ["postgres://u@h/", ""],
    ["postgres://u@h/?sslmode=disable", ""],
  ])("%s -> %j", (url, name) => {
    expect(databaseNameFromUrl(url)).toBe(name);
  });

  it.each(["", "vistato_test", "not a url"])("rejects the invalid URL %j", (url) => {
    expect(() => databaseNameFromUrl(url)).toThrow(/Invalid database URL/);
  });
});

describe("assertTestDatabase", () => {
  it.each([
    "postgres://vistato:vistato@localhost:5433/vistato_test",
    "postgres://u@h/vistato_migrate_abc123_test",
    "postgres://u@h/vistato_test?sslmode=disable",
    "postgres://u@h1,h2:5433/vistato_test",
  ])("accepts %s", (url) => {
    expect(() => assertTestDatabase(url)).not.toThrow();
  });

  it.each([
    ["the development database", "postgres://vistato:vistato@localhost:5433/vistato"],
    ["a production-like name", "postgres://u@h/vistato_prod"],
    ["_test elsewhere in the name", "postgres://u@h/vistato_test_old"],
    ["a different case", "postgres://u@h/vistato_TEST"],
    ["a bare _test", "postgres://u@h/_test"],
    ["a missing database name (fallback to PGDATABASE/user)", "postgres://u@h"],
    ["an empty database name", "postgres://u@h/?sslmode=disable"],
    ["_test only in the query string", "postgres://u@h/vistato?x=_test"],
    ["a `database` query parameter overriding the path", "postgres://u@h/vistato_test?database=vistato"],
    ["_test only in the user name", "postgres://vistato_test@h/vistato"],
    ["_test only in the host", "postgres://u@db_test/vistato"],
    ["an URL-encoded suffix (postgres.js does not decode it)", "postgres://u@h/vistato%5Ftest"],
  ])("rejects %s", (_, url) => {
    expect(() => assertTestDatabase(url)).toThrow(/Refusing to use database/);
  });

  it("does not print the password in the error", () => {
    expect(() => assertTestDatabase("postgres://u:s3cret@h/vistato")).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("s3cret") }),
    );
  });
});

describe("MIGRATIONS_FOLDER", () => {
  it("points to drizzle/ at the repository root", () => {
    expect(MIGRATIONS_FOLDER).toBe(path.resolve(__dirname, "../../drizzle"));
    expect(existsSync(path.join(MIGRATIONS_FOLDER, "meta/_journal.json"))).toBe(true);
  });
});
