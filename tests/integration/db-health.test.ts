import { afterEach, describe, expect, it, vi } from "vitest";

const globalForDb = globalThis as unknown as { sql?: { end: () => Promise<void> }; db?: unknown };

async function resetPool() {
  await globalForDb.sql?.end();
  delete globalForDb.sql;
  delete globalForDb.db;
  vi.resetModules();
}

describe("pingDatabase", () => {
  const originalUrl = process.env.DATABASE_URL;

  afterEach(async () => {
    process.env.DATABASE_URL = originalUrl;
    await resetPool();
  });

  it("returns true when the database answers", async () => {
    const { pingDatabase } = await import("@/db/health");
    expect(await pingDatabase()).toBe(true);
  });

  it("returns false, without throwing, when the database is unreachable", async () => {
    process.env.DATABASE_URL = "postgres://nobody:nothing@127.0.0.1:1/none";
    const { pingDatabase } = await import("@/db/health");
    expect(await pingDatabase()).toBe(false);
  });

  it("returns false, without throwing, when DATABASE_URL is not set", async () => {
    delete process.env.DATABASE_URL;
    const { pingDatabase } = await import("@/db/health");
    expect(await pingDatabase()).toBe(false);
  });
});
