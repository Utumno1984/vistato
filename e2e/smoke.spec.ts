import { expect, test } from "@playwright/test";

test("API entry point exposes discoverable links", async ({ request }) => {
  const res = await request.get("/api");
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body._links.health.href).toBe("/api/health");
});

test("health check reports the database as up", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect((await res.json()).checks.database).toBe("up");
});

test("home page renders", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Vistato");
});
