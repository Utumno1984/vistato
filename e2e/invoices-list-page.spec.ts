import { expect, test, type Page } from "@playwright/test";

import { createTestTenant } from "./helpers/create-test-tenant";
import { manyInvoices, seedInvoices } from "./helpers/seed-invoices";

async function newTenant() {
  return createTestTenant({ users: [{ role: "USER" }] });
}

async function login(page: Page, tenant: Awaited<ReturnType<typeof newTenant>>) {
  const res = await page.request.post("/api/auth/login", {
    data: { email: tenant.users[0].email, password: tenant.users[0].password },
  });
  expect(res.status()).toBe(200);
}

const rows = (page: Page) => page.locator("tbody tr");

test("shows the table with the 5 columns and only the rows of the own tenant", async ({ page }) => {
  const [a, b] = [await newTenant(), await newTenant()];
  seedInvoices(a, manyInvoices(3, "A"));
  seedInvoices(b, [{ supplierName: "Altro Tenant Srl", number: "B-1", date: "2026-01-01", amountCents: 100 }]);
  await login(page, a);
  await page.goto("/fatture");
  await expect(page.getByRole("columnheader")).toHaveText(["Fornitore", "Numero", "Data", "Importo", "Stato"]);
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByText("Altro Tenant Srl")).toHaveCount(0);
  await expect(page.getByText("Nessuna fattura")).toHaveCount(0);
});

test("formats date, amounts (positive, negative, zero, large, other currency) and status", async ({ page }) => {
  const tenant = await newTenant();
  seedInvoices(tenant, [
    { supplierName: "Positivo", number: "1", date: "2026-03-05", amountCents: 123450, status: "PENDING" },
    { supplierName: "Negativo", number: "2", date: "2026-03-06", amountCents: -1000, status: "APPROVED" },
    { supplierName: "Zero", number: "3", date: "2026-03-07", amountCents: 0, status: "REJECTED" },
    { supplierName: "Dollari", number: "4", date: "2026-03-08", amountCents: 10000, currency: "USD" },
    { supplierName: "Enorme", number: "5", date: "2024-02-29", amountCents: 1999999999999 },
  ]);
  await login(page, tenant);
  await page.goto("/fatture");
  const row = (name: string) => rows(page).filter({ hasText: name });
  await expect(row("Positivo")).toContainText("05/03/2026");
  await expect(row("Positivo")).toContainText("1.234,50 €");
  await expect(row("Positivo")).toContainText("Da approvare");
  await expect(row("Negativo")).toContainText("-10,00 €");
  await expect(row("Negativo")).toContainText("Approvata");
  await expect(row("Zero")).toContainText("0,00 €");
  await expect(row("Zero")).toContainText("Rifiutata");
  await expect(row("Dollari")).toContainText("100,00 USD");
  await expect(row("Enorme")).toContainText("19.999.999.999,99 €");
  await expect(row("Enorme")).toContainText("29/02/2024");
});

test("long and accented supplier names are shown whole", async ({ page }) => {
  const tenant = await newTenant();
  const long = `Società Cooperativa Àgricola ${"Lunghissimo".repeat(15)} è già`;
  seedInvoices(tenant, [{ supplierName: long, number: "L-1", date: "2026-03-05", amountCents: 100 }]);
  await login(page, tenant);
  await page.goto("/fatture");
  await expect(rows(page).first()).toContainText(long);
});

test("the status filter changes the URL, narrows the table and highlights the active filter", async ({ page }) => {
  const tenant = await newTenant();
  seedInvoices(tenant, [
    { supplierName: "P1", number: "1", date: "2026-03-05", amountCents: 100 },
    { supplierName: "A1", number: "2", date: "2026-03-05", amountCents: 100, status: "APPROVED" },
    { supplierName: "A2", number: "3", date: "2026-03-05", amountCents: 100, status: "APPROVED" },
    { supplierName: "R1", number: "4", date: "2026-03-05", amountCents: 100, status: "REJECTED" },
  ]);
  await login(page, tenant);
  await page.goto("/fatture");
  const filter = page.getByRole("navigation", { name: "Filtro per stato" });
  await expect(filter.getByRole("link")).toHaveText(["Tutte", "Da approvare", "Approvate", "Rifiutate"]);
  await expect(rows(page)).toHaveCount(4);
  await expect(filter.getByRole("link", { name: "Tutte" })).toHaveAttribute("aria-current", "page");

  await filter.getByRole("link", { name: "Approvate" }).click();
  await expect(page).toHaveURL(/\/fatture\?status=APPROVED$/);
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).filter({ hasText: "Approvata" })).toHaveCount(2);
  await expect(filter.getByRole("link", { name: "Approvate" })).toHaveAttribute("aria-current", "page");
  await expect(filter.getByRole("link", { name: "Tutte" })).not.toHaveAttribute("aria-current");

  await filter.getByRole("link", { name: "Rifiutate" }).click();
  await expect(page).toHaveURL(/status=REJECTED$/);
  await expect(rows(page)).toHaveCount(1);
  await filter.getByRole("link", { name: "Da approvare" }).click();
  await expect(rows(page)).toHaveCount(1);
  await filter.getByRole("link", { name: "Tutte" }).click();
  await expect(page).toHaveURL(/\/fatture$/);
  await expect(rows(page)).toHaveCount(4);
});

test("25 invoices: 20 rows on page 1 without Precedente, 5 on page 2 keeping the status", async ({ page }) => {
  const tenant = await newTenant();
  seedInvoices(tenant, manyInvoices(25));
  await login(page, tenant);
  await page.goto("/fatture");
  await expect(rows(page)).toHaveCount(20);
  await expect(page.getByText("Pagina 1 di 2")).toBeVisible();
  await expect(page.getByRole("link", { name: "Precedente" })).toHaveCount(0);
  await page.getByRole("link", { name: "Successiva" }).click();
  await expect(page).toHaveURL(/\/fatture\?page=2$/);
  await expect(rows(page)).toHaveCount(5);
  await expect(page.getByText("Pagina 2 di 2")).toBeVisible();
  await expect(page.getByRole("link", { name: "Successiva" })).toHaveCount(0);
  await page.getByRole("link", { name: "Precedente" }).click();
  await expect(page).toHaveURL(/\/fatture$/);
  await expect(rows(page)).toHaveCount(20);

  await page.goto("/fatture?status=PENDING");
  await expect(page.getByRole("link", { name: "Successiva" })).toHaveAttribute(
    "href",
    "/fatture?status=PENDING&page=2",
  );
});

test("a page past the last shows no table, the empty message and Precedente", async ({ page }) => {
  const tenant = await newTenant();
  seedInvoices(tenant, manyInvoices(25));
  await login(page, tenant);
  await page.goto("/fatture?page=9");
  await expect(page.getByText("Nessuna fattura")).toBeVisible();
  await expect(page.locator("table")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Successiva" })).toHaveCount(0);
  await page.getByRole("link", { name: "Precedente" }).click();
  await expect(page).toHaveURL(/\/fatture\?page=2$/);
  await expect(rows(page)).toHaveCount(5);
});

test("a tenant without invoices, or none in the filtered status, sees Nessuna fattura and no table", async ({
  page,
}) => {
  const tenant = await newTenant();
  await login(page, tenant);
  await page.goto("/fatture");
  await expect(page.getByText("Nessuna fattura")).toBeVisible();
  await expect(page.locator("table")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Successiva" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Precedente" })).toHaveCount(0);

  seedInvoices(tenant, manyInvoices(2));
  await page.goto("/fatture?status=REJECTED");
  await expect(page.getByText("Nessuna fattura")).toBeVisible();
  await expect(page.locator("table")).toHaveCount(0);
});

test("invalid status and page values fall back to the defaults without errors", async ({ page }) => {
  const tenant = await newTenant();
  seedInvoices(tenant, [
    { supplierName: "P1", number: "1", date: "2026-03-05", amountCents: 100 },
    { supplierName: "A1", number: "2", date: "2026-03-05", amountCents: 100, status: "APPROVED" },
  ]);
  await login(page, tenant);
  const queries = [
    "status=pending",
    "status=",
    "status=BOH",
    "status=PENDING&status=APPROVED",
    "page=0",
    "page=-1",
    "page=abc",
    "page=1.5",
    "page=1&page=2",
    "page=99999999999999999999",
    "pageSize=1",
    "status=pending&page=abc",
  ];
  for (const query of queries) {
    const res = await page.goto(`/fatture?${query}`);
    expect(res?.status(), query).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Fatture" }), query).toBeVisible();
    await expect(rows(page), query).toHaveCount(2);
    await expect(page.getByText("Pagina 1 di 1"), query).toBeVisible();
  }
  // A valid value next to an invalid one is kept.
  await page.goto("/fatture?status=APPROVED&page=abc");
  await expect(rows(page)).toHaveCount(1);
});

test("a page past the last of an empty tenant shows no 'Pagina X di 0'", async ({ page }) => {
  const tenant = await newTenant();
  await login(page, tenant);
  await page.goto("/fatture?page=3");
  await expect(page.getByText("Nessuna fattura")).toBeVisible();
  await expect(page.getByText(/Pagina/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Precedente" })).toBeVisible();
});

test("only the active filter has aria-current=page", async ({ page }) => {
  const tenant = await newTenant();
  seedInvoices(tenant, manyInvoices(1));
  await login(page, tenant);
  await page.goto("/fatture?status=REJECTED");
  const filter = page.getByRole("navigation", { name: "Filtro per stato" });
  await expect(filter.locator("[aria-current]")).toHaveCount(1);
  await expect(filter.getByRole("link", { name: "Rifiutate" })).toHaveAttribute("aria-current", "page");
});

test("the invoice number links to the detail page", async ({ page }) => {
  const tenant = await newTenant();
  seedInvoices(tenant, [{ supplierName: "Linkata Srl", number: "LNK-1", date: "2026-03-05", amountCents: 100 }]);
  await login(page, tenant);
  await page.goto("/fatture");
  await rows(page).getByRole("link", { name: "LNK-1" }).click();
  await expect(page).toHaveURL(/\/fatture\/[0-9a-f-]{36}$/);
  await expect(page.getByText("Linkata Srl")).toBeVisible();
});

test("an anonymous visitor is sent to /login keeping the query in next", async ({ page }) => {
  await page.goto("/fatture?status=PENDING");
  await expect(page).toHaveURL(/\/login\?next=%2Ffatture%3Fstatus%3DPENDING$/);
});

test("the page loads without console errors or uncaught exceptions", async ({ page }) => {
  const tenant = await newTenant();
  seedInvoices(tenant, manyInvoices(22));
  await login(page, tenant);
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto("/fatture");
  await page.getByRole("link", { name: "Successiva" }).click();
  await expect(rows(page)).toHaveCount(2);
  await page.getByRole("link", { name: "Approvate" }).click();
  await expect(page.getByText("Nessuna fattura")).toBeVisible();
  expect(problems).toEqual([]);
});
