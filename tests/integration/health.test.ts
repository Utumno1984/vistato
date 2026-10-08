import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

async function resetPool() {
  const { closeDb } = await import("@/db/client");
  await closeDb();
  vi.resetModules();
}

describe("GET /api/health", () => {
  const originalUrl = process.env.DATABASE_URL;

  afterEach(async () => {
    process.env.DATABASE_URL = originalUrl;
    await resetPool();
  });
  afterAll(resetPool);

  it("returns 200 with database up", async () => {
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      checks: { database: "up" },
      _links: { self: { href: "/api/health" } },
    });
  });

  it("returns 503 when the database is unreachable", async () => {
    process.env.DATABASE_URL = "postgres://nobody:nothing@127.0.0.1:1/none";
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).checks.database).toBe("down");
  });
});
