import { afterEach, describe, expect, it, vi } from "vitest";

async function loadClient() {
  return import("@/db/client");
}

describe("application connection pool", () => {
  afterEach(async () => {
    await (await loadClient()).closeDb();
    vi.resetModules();
  });

  it("is not reachable through plain globalThis properties", async () => {
    const { getDb, getSql } = await loadClient();
    getDb();
    getSql();
    const plain = globalThis as Record<string, unknown>;
    expect(plain.db).toBeUndefined();
    expect(plain.sql).toBeUndefined();
    expect(Object.keys(globalThis).some((k) => /^(db|sql|pool)$/i.test(k))).toBe(false);
  });

  it("survives a module reload (Next.js dev HMR) without opening a second pool", async () => {
    const first = (await loadClient()).getSql();
    vi.resetModules();
    const second = (await loadClient()).getSql();
    expect(second).toBe(first);
  });

  it("closeDb ends the pool and the next call opens a new working one", async () => {
    const client = await loadClient();
    const first = client.getSql();
    const db = client.getDb();
    await client.closeDb();

    const second = client.getSql();
    expect(second).not.toBe(first);
    expect(client.getDb()).not.toBe(db);
    const [row] = await second`select 1 as one`;
    expect(row.one).toBe(1);
  });

  it("closeDb is harmless when no pool is open", async () => {
    const { closeDb } = await loadClient();
    await closeDb();
    await expect(closeDb()).resolves.toBeUndefined();
  });
});
