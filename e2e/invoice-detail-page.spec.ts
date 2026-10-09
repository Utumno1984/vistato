import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { forTenant } from "@/db/tenant-scope";

import { createTestTenant, type TestUser } from "./helpers/create-test-tenant";
import { buildInvoiceXml } from "./helpers/fatturapa";

type Playwright = { request: { newContext: (o: { baseURL: string }) => Promise<APIRequestContext> } };

const SUPPLIER = "Caffè & Co. S.r.l.";

async function setup() {
  const tenant = await createTestTenant({ users: [{ role: "ADMIN" }, { role: "OWNER" }, { role: "USER" }] });
  const byRole = (role: string) => tenant.users.find((u) => u.role === role)!;
  return { tenant, admin: byRole("ADMIN"), owner: byRole("OWNER"), user: byRole("USER") };
}

async function login(page: Page, user: TestUser) {
  const res = await page.request.post("/api/auth/login", { data: { email: user.email, password: user.password } });
  expect(res.status()).toBe(200);
}

async function apiClient(playwright: Playwright, baseURL: string, user: TestUser) {
  const client = await playwright.request.newContext({ baseURL });
  const res = await client.post("/api/auth/login", { data: { email: user.email, password: user.password } });
  expect(res.status()).toBe(200);
  return client;
}

let counter = 0;
/** Uploads a PENDING invoice through the API as the logged-in client; returns its ID and number. */
async function upload(client: APIRequestContext, options: { vatCode?: string; date?: string; total?: string } = {}) {
  const number = `D-${Date.now()}-${counter++}`;
  const res = await client.post("/api/invoices", {
    multipart: {
      file: { name: "f.xml", mimeType: "text/xml", buffer: Buffer.from(buildInvoiceXml({ number, ...options })) },
    },
  });
  expect(res.status()).toBe(201);
  const { id } = await res.json();
  return { id: id as string, number };
}

function watchConsole(page: Page) {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  return problems;
}

const approveButton = (page: Page) => page.getByRole("button", { name: "Approva", exact: true });
const rejectButton = (page: Page) => page.getByRole("button", { name: "Rifiuta", exact: true });
/** The page's own error message (the Next.js route announcer also has role=alert). */
const alert = (page: Page) => page.locator("p[role=alert]");
const status =(page: Page, label: string) => page.locator("dd", { hasText: new RegExp(`^${label}$`) });

test("from the list to the detail: all fields are shown", async ({ page, playwright, baseURL }) => {
  const { user } = await setup();
  const client = await apiClient(playwright, baseURL!, user);
  const { id, number } = await upload(client, { vatCode: "09876543210", date: "2024-02-29", total: "1234.50" });
  await login(page, user);
  await page.goto("/fatture");
  await page.locator("tbody tr").filter({ hasText: number }).getByRole("link", { name: number }).click();
  await expect(page).toHaveURL(new RegExp(`/fatture/${id}$`));
  const field = (label: string) =>
    page.locator("dt", { hasText: new RegExp(`^${label}$`) }).locator("xpath=following-sibling::dd[1]");
  await expect(field("Fornitore")).toHaveText(SUPPLIER);
  await expect(field("Partita IVA")).toHaveText("IT 09876543210");
  await expect(field("Tipo documento")).toHaveText("TD01");
  await expect(field("Numero")).toHaveText(number);
  await expect(field("Data")).toHaveText("29/02/2024");
  await expect(field("Importo")).toHaveText("1.234,50 €");
  await expect(field("Stato")).toHaveText("Da approvare");
  await expect(field("Caricata il")).toHaveText(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
  await expect(page.getByText(/Approvata da|Rifiutata da/)).toHaveCount(0);
});

test("ADMIN and OWNER see Approva and Rifiuta on a PENDING invoice, USER does not", async ({
  page,
  playwright,
  baseURL,
}) => {
  const { admin, owner, user } = await setup();
  const { id } = await upload(await apiClient(playwright, baseURL!, user));
  for (const who of [admin, owner]) {
    await page.context().clearCookies();
    await login(page, who);
    await page.goto(`/fatture/${id}`);
    await expect(approveButton(page)).toBeVisible();
    await expect(rejectButton(page)).toBeVisible();
  }
  await page.context().clearCookies();
  await login(page, user);
  await page.goto(`/fatture/${id}`);
  await expect(page.getByRole("heading", { name: "Fattura", exact: true })).toBeVisible();
  await expect(approveButton(page)).toHaveCount(0);
  await expect(rejectButton(page)).toHaveCount(0);
});

test("ADMIN approves: Approvata, decider and time shown, buttons gone, list says Approvata", async ({
  page,
  playwright,
  baseURL,
}) => {
  const { admin, user } = await setup();
  const { id, number } = await upload(await apiClient(playwright, baseURL!, user));
  const problems = watchConsole(page);
  await login(page, admin);
  await page.goto(`/fatture/${id}`);
  await approveButton(page).click();
  await expect(page.getByText(/^Approvata da E2E ADMIN il \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/)).toBeVisible();
  await expect(status(page, "Approvata")).toBeVisible();
  await expect(approveButton(page)).toHaveCount(0);
  await expect(rejectButton(page)).toHaveCount(0);
  await page.getByRole("link", { name: "Torna all'elenco" }).click();
  await expect(page).toHaveURL(/\/fatture$/);
  await expect(page.locator("tbody tr").filter({ hasText: number })).toContainText("Approvata");
  expect(problems).toEqual([]);
});

test("a double click on Approva makes a single decision without errors", async ({ page, playwright, baseURL }) => {
  const { admin, user } = await setup();
  const { id } = await upload(await apiClient(playwright, baseURL!, user));
  const problems = watchConsole(page);
  await login(page, admin);
  await page.goto(`/fatture/${id}`);
  await approveButton(page).dblclick();
  await expect(page.getByText(/^Approvata da E2E ADMIN il /)).toBeVisible();
  await expect(alert(page)).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("reject with a reason shows Rifiutata, the reason (newlines, accents, no HTML) and the decider", async ({
  page,
  playwright,
  baseURL,
}) => {
  const { owner, user } = await setup();
  const { id } = await upload(await apiClient(playwright, baseURL!, user));
  const problems = watchConsole(page);
  await login(page, owner);
  await page.goto(`/fatture/${id}`);
  await rejectButton(page).click();
  const reason = 'Importo errato\nè già pagata <img src=x onerror="window.__xss=1"> <b>grassetto</b>';
  await page.getByLabel("Motivo (facoltativo)").fill(reason);
  await page.getByRole("button", { name: "Conferma rifiuto" }).click();
  await expect(page.getByText(/^Rifiutata da E2E OWNER il \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/)).toBeVisible();
  await expect(status(page, "Rifiutata")).toBeVisible();
  const shown = page.locator("span.whitespace-pre-wrap");
  await expect(shown).toHaveText(reason);
  await expect(shown.locator("img, b")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  await expect(approveButton(page)).toHaveCount(0);
  await expect(rejectButton(page)).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("reject without a reason succeeds and shows no reason", async ({ page, playwright, baseURL }) => {
  const { admin, user } = await setup();
  const { id } = await upload(await apiClient(playwright, baseURL!, user));
  await login(page, admin);
  await page.goto(`/fatture/${id}`);
  await rejectButton(page).click();
  await page.getByRole("button", { name: "Conferma rifiuto" }).click();
  await expect(page.getByText(/^Rifiutata da E2E ADMIN il /)).toBeVisible();
  await expect(page.getByText("Motivo:")).toHaveCount(0);
});

test("cancelling Rifiuta sends no request and keeps the invoice PENDING", async ({ page, playwright, baseURL }) => {
  const { admin, user } = await setup();
  const { id } = await upload(await apiClient(playwright, baseURL!, user));
  await login(page, admin);
  await page.goto(`/fatture/${id}`);
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(request.url());
  });
  await rejectButton(page).click();
  await page.getByLabel("Motivo (facoltativo)").fill("ci ripenso");
  await page.getByRole("button", { name: "Annulla" }).click();
  await expect(page.getByLabel("Motivo (facoltativo)")).toHaveCount(0);
  await expect(rejectButton(page)).toBeVisible();
  expect(posts).toEqual([]);
  await page.reload();
  await expect(status(page, "Da approvare")).toBeVisible();
});

test("a reason over 1000 characters (HTML limit bypassed) shows an error and the invoice stays PENDING", async ({
  page,
  playwright,
  baseURL,
}) => {
  const { admin, user } = await setup();
  const { id } = await upload(await apiClient(playwright, baseURL!, user));
  const problems = watchConsole(page);
  await login(page, admin);
  await page.goto(`/fatture/${id}`);
  await rejectButton(page).click();
  const textarea = page.getByLabel("Motivo (facoltativo)");
  await expect(textarea).toHaveAttribute("maxlength", "1000");
  await textarea.evaluate((el) => el.removeAttribute("maxlength"));
  await textarea.fill("x".repeat(1001));
  await page.getByRole("button", { name: "Conferma rifiuto" }).click();
  await expect(alert(page)).toContainText("1000");
  await expect(status(page, "Da approvare")).toBeVisible();
  await page.reload();
  await expect(status(page, "Da approvare")).toBeVisible();
  expect(problems).toEqual([]);
});

test("an invoice decided by someone else after the page opened: conflict message and updated state", async ({
  page,
  playwright,
  baseURL,
}) => {
  const { admin, owner, user } = await setup();
  const { id } = await upload(await apiClient(playwright, baseURL!, user));
  const problems = watchConsole(page);
  await login(page, admin);
  await page.goto(`/fatture/${id}`);
  await expect(approveButton(page)).toBeVisible();
  const other = await apiClient(playwright, baseURL!, owner);
  expect((await other.post(`/api/invoices/${id}/reject`, { data: { reason: "no" } })).status()).toBe(200);
  await approveButton(page).click();
  await expect(alert(page)).toHaveText("La fattura è già stata approvata o rifiutata");
  await expect(status(page, "Rifiutata")).toBeVisible();
  await expect(page.getByText(/^Rifiutata da E2E OWNER il /)).toBeVisible();
  await expect(approveButton(page)).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("a user demoted to USER with the page open gets a permission error; buttons gone on reload", async ({
  page,
  playwright,
  baseURL,
}) => {
  const { tenant, admin, user } = await setup();
  const { id } = await upload(await apiClient(playwright, baseURL!, user));
  await login(page, admin);
  await page.goto(`/fatture/${id}`);
  await expect(approveButton(page)).toBeVisible();
  await forTenant(tenant.tenantId).users.update(admin.id, { role: "USER" });
  await approveButton(page).click();
  await expect(alert(page)).toContainText("permessi");
  await page.reload();
  await expect(status(page, "Da approvare")).toBeVisible();
  await expect(approveButton(page)).toHaveCount(0);
  await expect(rejectButton(page)).toHaveCount(0);
});

test("another tenant's invoice, an unknown ID and a non-UUID give the same 404 page", async ({
  page,
  playwright,
  baseURL,
}) => {
  const { admin } = await setup();
  const other = await createTestTenant({ users: [{ role: "USER" }] });
  const { id: foreignId } = await upload(await apiClient(playwright, baseURL!, other.users[0]));
  await login(page, admin);
  const bodies: string[] = [];
  for (const target of [foreignId, "00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
    const res = await page.goto(`/fatture/${target}`);
    expect(res?.status(), target).toBe(404);
    await expect(page.getByText("Fattura non trovata").first(), target).toBeVisible();
    await expect(approveButton(page), target).toHaveCount(0);
    bodies.push(await page.getByRole("main").innerText());
  }
  expect(new Set(bodies).size).toBe(1);
  await page.getByRole("link", { name: "Torna all'elenco" }).click();
  await expect(page).toHaveURL(/\/fatture$/);
});

test("an anonymous visitor is sent to /login keeping the invoice path in next", async ({ page }) => {
  const id = "00000000-0000-4000-8000-000000000000";
  await page.goto(`/fatture/${id}`);
  await expect(page).toHaveURL(new RegExp(`/login\\?next=%2Ffatture%2F${id}$`));
});

test("Torna all'elenco goes back to /fatture", async ({ page, playwright, baseURL }) => {
  const { user } = await setup();
  const { id } = await upload(await apiClient(playwright, baseURL!, user));
  await login(page, user);
  await page.goto(`/fatture/${id}`);
  await page.getByRole("link", { name: "Torna all'elenco" }).click();
  await expect(page).toHaveURL(/\/fatture$/);
});
