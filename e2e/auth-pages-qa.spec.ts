import http from "node:http";

import { expect, test, type Page } from "@playwright/test";

import { createTestTenant } from "./helpers/create-test-tenant";

async function login(page: Page, email: string, password: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Accedi" }).click();
}

function rawGet(path: string, headers: Record<string, string>): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: 3100, path, method: "GET", headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, location: res.headers.location });
    });
    req.on("error", reject);
    req.end();
  });
}

test("QA: a next with CR/LF is ignored after the login", async ({ page }) => {
  const tenant = await createTestTenant({ users: [{ role: "OWNER" }] });
  const user = tenant.users[0];
  await page.goto("/login?next=" + encodeURIComponent("/fatture\r\nSet-Cookie: x=1"));
  await login(page, user.email, user.password);
  await expect(page).toHaveURL(/\/fatture$/);
});

test("QA: the login form is submitted with Enter from the keyboard", async ({ page }) => {
  const tenant = await createTestTenant({ users: [{ role: "OWNER" }] });
  const user = tenant.users[0];
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/fatture$/);
});

test("QA: after Esci the browser back button does not show the protected page", async ({ page }) => {
  const tenant = await createTestTenant({ users: [{ role: "OWNER" }] });
  const user = tenant.users[0];
  await page.goto("/login");
  await login(page, user.email, user.password);
  await expect(page).toHaveURL(/\/fatture$/);
  await page.getByRole("button", { name: "Esci" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goBack();
  // Right after going back, without a reload: the protected page must not be on screen.
  await expect(page.getByRole("heading", { name: "Fatture" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Esci" })).toHaveCount(0);
  await page.reload();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: "Fatture" })).toHaveCount(0);
});

test("QA: a well-formed but unknown session token (valid shape) is sent to /login", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "vistato_session", value: "A".repeat(43), url: baseURL! }]);
  await page.goto("/fatture");
  await expect(page).toHaveURL(/\/login/);
  await expect(page).toHaveURL(/next=%2Ffatture/);
});

test("QA: the proxy redirect never points to a host taken from Host or X-Forwarded-Host", async () => {
  const cases: Record<string, string>[] = [
    { host: "evil.example" },
    { host: "127.0.0.1:3100", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" },
    { host: "evil.example", "x-forwarded-host": "evil.example" },
  ];
  for (const headers of cases) {
    const res = await rawGet("/fatture", headers);
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.location ?? "").not.toContain("evil.example");
  }
});

function rawBody(path: string, cookie: string): Promise<{ status: number; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: 3100, path, headers: { cookie } }, (r) => {
      let body = "";
      r.on("data", (c) => (body += c));
      r.on("end", () => resolve({ status: r.statusCode ?? 0, location: r.headers.location, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("QA: duplicate session cookies (one invented, one valid-shaped) do not open /fatture", async () => {
  const res = await rawBody("/fatture", `vistato_session=${"B".repeat(43)}; vistato_session=${"C".repeat(43)}`);
  expect(res.status).not.toBe(500);
  expect(res.body).not.toContain("Esci");
});

test("QA: with a valid and an invented session cookie the first one wins, in both orders", async ({ page, context }) => {
  const tenant = await createTestTenant({ users: [{ role: "OWNER" }] });
  const user = tenant.users[0];
  await page.goto("/login");
  await login(page, user.email, user.password);
  await expect(page).toHaveURL(/\/fatture$/);
  const valid = (await context.cookies()).find((c) => c.name === "vistato_session")!.value;
  const invented = "D".repeat(43);

  const validFirst = await rawBody("/fatture", `vistato_session=${valid}; vistato_session=${invented}`);
  expect(validFirst.status).toBe(200);
  expect(validFirst.body).toContain("Esci");

  const inventedFirst = await rawBody("/fatture", `vistato_session=${invented}; vistato_session=${valid}`);
  expect(inventedFirst.body).not.toContain("Esci");
  expect(inventedFirst.status).toBeGreaterThanOrEqual(300);
  expect(inventedFirst.status).toBeLessThan(400);
  expect(inventedFirst.location ?? "").toContain("/login");
});

test("QA: login form fields are labelled and keyboard reachable", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel("Email")).toHaveAttribute("type", "email");
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("type", "password");
  await page.getByLabel("Email").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Accedi" })).toBeFocused();
});
