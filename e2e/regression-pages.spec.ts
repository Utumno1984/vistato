import { expect, test } from "@playwright/test";

test("regression: home page has the expected document metadata", async ({ page }) => {
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);
  await expect(page.locator("html")).toHaveAttribute("lang", "it");
  await expect(page).toHaveTitle("Vistato");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    "Approvazione delle fatture fornitori per le PMI",
  );
});

test("regression: home page shows the heading and the tagline", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Vistato", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Vistato");
  // A RegExp is case-sensitive, unlike a plain string.
  await expect(page.getByText(/Approvazione delle fatture fornitori/)).toBeVisible();
});

test("regression: home page loads without page errors or console errors", async ({ page }) => {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console.error: ${message.text()}`);
  });
  await page.goto("/", { waitUntil: "networkidle" });
  expect(problems).toEqual([]);
});

test("regression: GET /favicon.ico answers 200 with an image", async ({ request }) => {
  const res = await request.get("/favicon.ico");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toMatch(/^image\//);
});
