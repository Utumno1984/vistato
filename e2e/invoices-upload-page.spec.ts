import { expect, test, type Page } from "@playwright/test";

import { createTestTenant } from "./helpers/create-test-tenant";
import { buildInvoiceXml } from "./helpers/fatturapa";
import { seedInvoices } from "./helpers/seed-invoices";

async function setup(page: Page) {
  const tenant = await createTestTenant({ users: [{ role: "USER" }] });
  const res = await page.request.post("/api/auth/login", {
    data: { email: tenant.users[0].email, password: tenant.users[0].password },
  });
  expect(res.status()).toBe(200);
  return tenant;
}

const xmlFile = (xml: string, name = "fattura.xml") => ({
  name,
  mimeType: "application/xml",
  buffer: Buffer.from(xml, "utf8"),
});
// Scoped to the form: Next adds its own role="alert" route announcer.
const alertOf = (page: Page) => page.getByRole("region", { name: "Carica fattura" }).getByRole("alert");
const rows =(page: Page) => page.locator("tbody tr");
const chooseAndSend = async (page: Page, file: ReturnType<typeof xmlFile>) => {
  await page.getByLabel("File XML").setInputFiles(file);
  await page.getByRole("button", { name: "Carica" }).click();
};

test("shows the upload form with an xml-only file field and the Carica button", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/fatture");
  await expect(
    page.getByRole("heading", { name: "Carica fattura" }),
  ).toBeVisible();
  await expect(page.getByLabel("File XML")).toHaveAttribute("accept", /\.xml/);
  await expect(page.getByRole("button", { name: "Carica" })).toBeEnabled();
});

test("a valid XML shows Fattura caricata and the new invoice on top as Da approvare", async ({
  page,
}) => {
  const tenant = await setup(page);
  seedInvoices(tenant, [
    {
      supplierName: "Vecchio",
      number: "OLD-1",
      date: "2020-01-01",
      amountCents: 100,
    },
  ]);
  await page.goto("/fatture");
  await expect(rows(page)).toHaveCount(1);
  await chooseAndSend(page, xmlFile(buildInvoiceXml({ number: "NUOVA-1" })));
  await expect(page.getByText("Fattura caricata")).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).first()).toContainText("NUOVA-1");
  await expect(rows(page).first()).toContainText("Da approvare");
});

test("an invalid XML shows the Italian validation messages and adds no row", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/fatture");
  await chooseAndSend(page, xmlFile(buildInvoiceXml({ date: "2024-13-45" })));
  await expect(alertOf(page)).toContainText(
    "La data della fattura non è valida",
  );
  await expect(page.getByText("Fattura caricata")).toHaveCount(0);
  await expect(rows(page)).toHaveCount(0);
});

test("a duplicate shows Questa fattura è già stata caricata", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/fatture");
  const file = xmlFile(buildInvoiceXml({ number: "DUP-1" }));
  await chooseAndSend(page, file);
  await expect(page.getByText("Fattura caricata")).toBeVisible();
  await chooseAndSend(page, file);
  await expect(alertOf(page)).toHaveText(
    "Questa fattura è già stata caricata",
  );
  await expect(rows(page)).toHaveCount(1);
});

test("a .p7m, a non-xml file and a file over 5 MB show specific messages and add no row", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/fatture");
  const xml = buildInvoiceXml();

  await chooseAndSend(page, xmlFile(xml, "fattura.xml.p7m"));
  await expect(alertOf(page)).toContainText(".p7m");
  await chooseAndSend(page, xmlFile(xml, "fattura.pdf"));
  await expect(alertOf(page)).toContainText("solo file XML");

  const big = xmlFile(
    `${xml}<!--${"x".repeat(5 * 1024 * 1024 + 10)}-->`,
    "grande.xml",
  );
  await chooseAndSend(page, big);
  await expect(alertOf(page)).toHaveText(
    "Il file supera la dimensione massima di 5 MB",
  );
  await expect(rows(page)).toHaveCount(0);
});

test("sending without a file shows Seleziona un file XML", async ({ page }) => {
  await setup(page);
  await page.goto("/fatture");
  await page.getByRole("button", { name: "Carica" }).click();
  await expect(alertOf(page)).toHaveText("Seleziona un file XML");
  await expect(rows(page)).toHaveCount(0);
});

test("an expired session at submit time leads to /login", async ({
  page,
  context,
}) => {
  await setup(page);
  await page.goto("/fatture");
  await page.getByLabel("File XML").setInputFiles(xmlFile(buildInvoiceXml()));
  await context.clearCookies();
  await page.getByRole("button", { name: "Carica" }).click();
  await expect(page).toHaveURL(/\/login/);
});

test("a double click creates a single invoice; accented file names work", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/fatture");
  await page
    .getByLabel("File XML")
    .setInputFiles(
      xmlFile(buildInvoiceXml({ number: "DC-1" }), "fattura è già più.xml"),
    );
  await page.getByRole("button", { name: "Carica" }).dblclick();
  await expect(
    page.getByText("Fattura caricata").or(page.getByText("già stata caricata")),
  ).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
});

test("with the Approvate filter the success message shows but the new invoice is not listed", async ({
  page,
}) => {
  const tenant = await setup(page);
  seedInvoices(tenant, [
    {
      supplierName: "Appr",
      number: "A-1",
      date: "2026-01-01",
      amountCents: 100,
      status: "APPROVED",
    },
  ]);
  await page.goto("/fatture?status=APPROVED");
  await chooseAndSend(page, xmlFile(buildInvoiceXml({ number: "F-1" })));
  await expect(page.getByText("Fattura caricata")).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("Appr");
});

test("no console errors after a successful and a failed upload", async ({
  page,
}) => {
  await setup(page);
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto("/fatture");
  await chooseAndSend(page, xmlFile(buildInvoiceXml()));
  await expect(page.getByText("Fattura caricata")).toBeVisible();
  await chooseAndSend(page, xmlFile(buildInvoiceXml({ date: "nope" })));
  await expect(alertOf(page)).toBeVisible();
  expect(problems).toEqual([]);
});
