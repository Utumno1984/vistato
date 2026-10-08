import { expect, test, type Page } from "@playwright/test";

import { forTenant } from "@/db/tenant-scope";

import { createTestTenant } from "./helpers/create-test-tenant";

const DEMO_EMAIL = "demo@example.com";

function demoPassword(): string {
  const password = process.env.DEMO_USER_PASSWORD;
  if (!password) throw new Error("DEMO_USER_PASSWORD is not set: the e2e seed needs it (see .env.example)");
  return password;
}

async function fillAndSubmit(page: Page, email: string, password: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Accedi" }).click();
}

async function newUser(role: "OWNER" | "USER" = "OWNER") {
  const tenant = await createTestTenant({ users: [{ role }] });
  return { tenant, user: tenant.users[0] };
}

test("an anonymous visitor opening /fatture is sent to /login?next=%2Ffatture and sees the form", async ({ page }) => {
  await page.goto("/fatture");
  await expect(page).toHaveURL(/\/login\?next=%2Ffatture$/);
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accedi" })).toBeVisible();
});

test("the demo user logs in and lands on /fatture with the title, their name and the tenant", async ({ page }) => {
  await page.goto("/login");
  await fillAndSubmit(page, DEMO_EMAIL, demoPassword());
  await expect(page).toHaveURL(/\/fatture$/);
  await expect(page.getByRole("heading", { level: 1, name: "Fatture" })).toBeVisible();
  await expect(page.getByText("Demo Vistato")).toBeVisible();
  await expect(page.getByText("Vistato Demo S.r.l.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Esci" })).toBeVisible();
});

test("login of a test user leads to /fatture showing the user's name and tenant, and goes to next when given", async ({ page }) => {
  const { tenant, user } = await newUser();
  await page.goto("/fatture/dettaglio?status=PENDING");
  await expect(page).toHaveURL(/\/login\?next=%2Ffatture%2Fdettaglio%3Fstatus%3DPENDING$/);
  await fillAndSubmit(page, user.email, user.password);
  // The sub-page does not exist yet: the redirect target is preserved, query string included.
  await expect(page).toHaveURL(/\/fatture\/dettaglio\?status=PENDING$/);

  await page.goto("/fatture");
  await expect(page.getByTestId("user-name")).toHaveText("E2E OWNER");
  await expect(page.getByTestId("tenant-name")).toHaveText(tenant.businessName);
});

test("a login with next=/fatture?status=PENDING preserves the query string", async ({ page }) => {
  const { user } = await newUser();
  await page.goto("/login?next=%2Ffatture%3Fstatus%3DPENDING");
  await fillAndSubmit(page, user.email, user.password);
  await expect(page).toHaveURL(/\/fatture\?status=PENDING$/);
  await expect(page.getByRole("heading", { level: 1, name: "Fatture" })).toBeVisible();
});

test("wrong credentials: the page stays on /login with the message, the email kept and the password empty", async ({ page }) => {
  const { user } = await newUser();
  await page.goto("/login");
  await fillAndSubmit(page, user.email, `${user.password}x`);
  await expect(page.getByRole("alert").filter({ hasText: "Email o password non validi" })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByLabel("Email")).toHaveValue(user.email);
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
});

async function expectNextIgnored(page: Page, next: string) {
  const { user } = await newUser();
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await fillAndSubmit(page, user.email, user.password);
  await expect(page).toHaveURL(/\/fatture$/);
  expect(new URL(page.url()).hostname).toBe("localhost");
}

test("an absolute next is ignored: after the login the user lands on /fatture", async ({ page }) => {
  await expectNextIgnored(page, "https://evil.example");
});

test("a protocol-relative next is ignored: after the login the user lands on /fatture", async ({ page }) => {
  await expectNextIgnored(page, "//evil.example");
});

test("a next with a backslash is ignored: after the login the user lands on /fatture", async ({ page }) => {
  await expectNextIgnored(page, "/\\evil.example");
});

test("a next not starting with a slash is ignored: after the login the user lands on /fatture", async ({ page }) => {
  await expectNextIgnored(page, "evil.example/x");
});

test("an authenticated user opening /login is sent to /fatture", async ({ page }) => {
  const { user } = await newUser();
  await page.goto("/login");
  await fillAndSubmit(page, user.email, user.password);
  await expect(page).toHaveURL(/\/fatture$/);
  await page.goto("/login");
  await expect(page).toHaveURL(/\/fatture$/);
});

test("Esci deletes the session, goes to /login, and /fatture redirects there again", async ({ page, context }) => {
  const { user, tenant } = await newUser();
  await page.goto("/login");
  await fillAndSubmit(page, user.email, user.password);
  await expect(page).toHaveURL(/\/fatture$/);
  const token = (await context.cookies()).find((cookie) => cookie.name === "vistato_session")?.value;
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

  await page.getByRole("button", { name: "Esci" }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await context.cookies()).find((cookie) => cookie.name === "vistato_session")).toBeUndefined();

  await page.goto("/fatture");
  await expect(page).toHaveURL(/\/login\?next=%2Ffatture$/);

  // The old cookie is dead on the server too, not just removed from the browser.
  const me = await page.request.get("/api/me", { headers: { cookie: `vistato_session=${token}` } });
  expect(me.status()).toBe(401);
  expect(tenant.tenantId).toBeTruthy();
});

test("an invented cookie does not open /fatture: the server check sends the visitor to /login", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "vistato_session", value: "x".repeat(43), url: baseURL! }]);
  await page.goto("/fatture");
  await expect(page).toHaveURL(/\/login(\?|$)/);
  await expect(page.getByRole("button", { name: "Accedi" })).toBeVisible();
});

test("a user disabled while signed in is sent to /login on the next navigation", async ({ page }) => {
  const { user, tenant } = await newUser("USER");
  await page.goto("/login");
  await fillAndSubmit(page, user.email, user.password);
  await expect(page).toHaveURL(/\/fatture$/);
  await forTenant(tenant.tenantId).users.update(user.id, { status: "DISABLED" });
  await page.goto("/fatture");
  await expect(page).toHaveURL(/\/login/);
});

test("empty fields are stopped by the browser and nothing is sent", async ({ page }) => {
  let requests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/auth/login")) requests++;
  });
  await page.goto("/login");
  await page.getByRole("button", { name: "Accedi" }).click();
  await expect(page.getByLabel("Email")).toHaveJSProperty("validity.valueMissing", true);
  await expect(page).toHaveURL(/\/login$/);
  expect(requests).toBe(0);
});

test("a double click on Accedi sends a single login request", async ({ page }) => {
  const { user } = await newUser();
  let requests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/auth/login") && request.method() === "POST") requests++;
  });
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Accedi" }).dblclick();
  await expect(page).toHaveURL(/\/fatture$/);
  expect(requests).toBe(1);
});

test("GET /api/me without a session stays a 401 JSON, not a redirect; /, /api and /api/health stay public", async ({ request }) => {
  const me = await request.get("/api/me", { maxRedirects: 0 });
  expect(me.status()).toBe(401);
  expect(me.headers()["content-type"]).toContain("application/json");
  for (const path of ["/", "/api", "/api/health"]) {
    expect((await request.get(path, { maxRedirects: 0 })).status(), path).toBe(200);
  }
});

function collectProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console.error: ${message.text()}`);
  });
  return problems;
}

test("/login loads without JS or console errors", async ({ page }) => {
  const problems = collectProblems(page);
  await page.goto("/login", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: "Accedi" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("/fatture loads without JS or console errors", async ({ page }) => {
  const { user } = await newUser();
  await page.goto("/login");
  await fillAndSubmit(page, user.email, user.password);
  await expect(page).toHaveURL(/\/fatture$/);
  const problems = collectProblems(page);
  await page.goto("/fatture", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: "Fatture" })).toBeVisible();
  expect(problems).toEqual([]);
});
