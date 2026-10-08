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
  await page.reload();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: "Fatture" })).toHaveCount(0);
});

test("QA: a well-formed but unknown session token (valid shape) is sent to /login", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "vistato_session", value: "A".repeat(43), url: baseURL! }]);
  await page.goto("/fatture");
  await expect(page).toHaveURL(/\/login/);
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

test("QA: duplicate session cookies (one invented, one valid-shaped) do not open /fatture", async () => {
  // Passes the optimistic proxy or is redirected; either way the page must not render for an unknown token.
  const page = await new Promise<string>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: 3100, path: "/fatture", headers: { cookie: `vistato_session=${"B".repeat(43)}; vistato_session=${"C".repeat(43)}` } },
      (r) => {
        let body = "";
        r.on("data", (c) => (body += c));
        r.on("end", () => resolve(`${r.statusCode} ${r.headers.location ?? ""} ${body.includes("Esci") ? "HAS-ESCI" : ""}`));
      },
    );
    req.on("error", reject);
    req.end();
  });
  expect(page).not.toMatch(/^500/);
  expect(page).not.toContain("HAS-ESCI");
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
