import { expect, test } from "@playwright/test";

interface Link {
  href: string;
  method?: string;
}

test("regression: GET /api describes the service and links to itself and the health check", async ({
  request,
}) => {
  const res = await request.get("/api");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("application/json");
  const body = await res.json();
  expect(body.name).toBe("vistato");
  expect(typeof body.version).toBe("string");
  expect(body.version.length).toBeGreaterThan(0);
  expect(body._links.self.href).toBe("/api");
  expect(body._links.health.href).toBe("/api/health");
});

test("regression: GET /api/health reports exactly status ok and database up", async ({
  request,
}) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("application/json");
  expect(await res.json()).toEqual({
    status: "ok",
    checks: { database: "up" },
    _links: { self: { href: "/api/health" } },
  });
});

test("regression: every GET link of /api answers 200 with a matching self link", async ({
  request,
}) => {
  const root = await (await request.get("/api")).json();
  const links = Object.entries(root._links as Record<string, Link>);
  let followed = 0;
  const followedRels: string[] = [];
  for (const [rel, link] of links) {
    if (link.method && link.method !== "GET") continue; // non-GET links are skipped
    followedRels.push(rel);
    const res = await request.get(link.href);
    expect(res.status(), `link "${rel}" (${link.href})`).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/json");
    const body = await res.json();
    expect(body._links.self.href, `link "${rel}"`).toBe(link.href);
    followed += 1;
  }
  // Guard against a walker that passes on an empty set of links.
  expect(followed).toBeGreaterThanOrEqual(2);
  expect(followedRels).toEqual(expect.arrayContaining(["self", "health"]));
});

// Next.js (16.3.x) answers 405 for a method the route file does not export.
test("regression: POST /api is rejected with 405", async ({ request }) => {
  expect((await request.post("/api")).status()).toBe(405);
});

test("regression: POST /api/health is rejected with 405", async ({ request }) => {
  expect((await request.post("/api/health")).status()).toBe(405);
});

test("regression: GET on an unknown API path answers 404", async ({ request }) => {
  const res = await request.get("/api/percorso-inesistente");
  expect(res.status()).toBe(404);
});
