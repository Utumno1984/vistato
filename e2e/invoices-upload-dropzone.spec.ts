import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { createTestTenant } from "./helpers/create-test-tenant";
import { buildInvoiceXml } from "./helpers/fatturapa";

const FIXTURE = readFileSync(
  join(process.cwd(), "tests", "fixtures", "fatturapa", "valid-prefix-p.xml"),
);

async function setup(page: Page) {
  const tenant = await createTestTenant({ users: [{ role: "USER" }] });
  const res = await page.request.post("/api/auth/login", {
    data: { email: tenant.users[0].email, password: tenant.users[0].password },
  });
  expect(res.status()).toBe(200);
  await page.goto("/fatture");
  return tenant;
}

const area = (page: Page) => page.locator("label[data-state]");
const successText = (page: Page) => page.getByText("Fattura caricata");
const alertOf = (page: Page) =>
  page.getByRole("region", { name: "Carica fattura" }).getByRole("alert");

/** Dispatches a drag event on the area carrying a DataTransfer with the given files. */
async function dragEvent(
  page: Page,
  target: Locator,
  type: string,
  files: { name: string; type: string; content: string }[] = [],
) {
  const transfer = await page.evaluateHandle((list) => {
    const dt = new DataTransfer();
    for (const f of list) dt.items.add(new File([f.content], f.name, { type: f.type }));
    return dt;
  }, files);
  await target.dispatchEvent(type, { dataTransfer: transfer });
}

const xml = (number: string) => ({
  name: `${number}.xml`,
  type: "application/xml",
  content: buildInvoiceXml({ number }),
});

test("shows a dashed area with icon, texts, the File XML field and the example link", async ({
  page,
}) => {
  await setup(page);
  await expect(
    page.getByText("Trascina qui il file XML o clicca per scegliere"),
  ).toBeVisible();
  await expect(page.getByText("Solo .xml, massimo 5 MB")).toBeVisible();
  await expect(area(page)).toHaveCSS("border-style", "dashed");
  await expect(area(page).locator("svg")).toBeVisible();
  await expect(area(page)).toHaveAttribute("data-state", "empty");
  await expect(page.getByLabel("File XML")).toHaveAttribute("accept", /\.xml/);
  const link = page.getByRole("link", { name: "Scarica un esempio" });
  await expect(link).toHaveAttribute("href", "/esempi/fattura-esempio.xml");
  await expect(link).toHaveAttribute("download", "");
});

test("clicking the area opens the file chooser; the chosen name is shown and the upload works", async ({
  page,
}) => {
  await setup(page);
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    area(page).click(),
  ]);
  await chooser.setFiles({
    name: "Caffè e più.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(buildInvoiceXml({ number: "CLICK-1" })),
  });
  await expect(area(page)).toContainText("Caffè e più.xml");
  await expect(area(page)).toHaveAttribute("data-state", "selected");
  await page.getByRole("button", { name: "Carica" }).click();
  await expect(successText(page)).toBeVisible();
  await expect(page.locator("tbody tr").first()).toContainText("CLICK-1");
  // The area is back to the initial state.
  await expect(area(page)).toHaveAttribute("data-state", "empty");
  await expect(area(page)).not.toContainText("Caffè e più.xml");
});

async function openWithKey(page: Page, key: string) {
  await setup(page);
  const input = page.getByLabel("File XML");
  // Wait until React has hydrated the field: a re-render after focus must not steal it.
  await expect
    .poll(() =>
      input.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$"))),
    )
    .toBe(true);
  await page.bringToFront();
  await input.focus();
  await expect(input).toBeFocused();
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.keyboard.press(key),
  ]);
  expect(chooser).toBeTruthy();
}

test("Tab reaches the area and Enter opens the file chooser", async ({ page }) => {
  await openWithKey(page, "Enter");
});

test("Tab reaches the area and Space opens the file chooser", async ({ page }) => {
  await openWithKey(page, "Space");
});

test("Tab from the page reaches the file field", async ({ page }) => {
  await setup(page);
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press("Tab");
    if (await page.getByLabel("File XML").evaluate((el) => el === document.activeElement)) {
      return;
    }
  }
  throw new Error("file field not reachable with Tab");
});

test("a cancelled chooser leaves the area in the initial state", async ({ page }) => {
  await setup(page);
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    area(page).click(),
  ]);
  await chooser.setFiles([]);
  await expect(area(page)).toHaveAttribute("data-state", "empty");
});

test("dragging over highlights the area, dragleave restores it, child leave does not flicker", async ({
  page,
}) => {
  await setup(page);
  const target = area(page);
  const child = page.getByText("Solo .xml, massimo 5 MB");
  await dragEvent(page, target, "dragenter");
  await dragEvent(page, target, "dragover");
  await expect(target).toHaveAttribute("data-state", "dragover");
  await expect(target).toContainText("Rilascia il file qui");
  // Moving onto a child: enter child, then leave the area itself.
  await dragEvent(page, child, "dragenter");
  await dragEvent(page, target, "dragleave");
  await expect(target).toHaveAttribute("data-state", "dragover");
  await dragEvent(page, child, "dragleave");
  await expect(target).toHaveAttribute("data-state", "empty");
  await expect(target).toContainText("Trascina qui il file XML");
});

test("dropping an XML selects it, shows its name and Carica uploads it", async ({ page }) => {
  await setup(page);
  const target = area(page);
  await dragEvent(page, target, "dragenter");
  await dragEvent(page, target, "drop", [xml("DROP-1")]);
  await expect(target).toHaveAttribute("data-state", "selected");
  await expect(target).toContainText("DROP-1.xml");
  await page.getByRole("button", { name: "Carica" }).click();
  await expect(successText(page)).toBeVisible();
  await expect(page.locator("tbody tr").first()).toContainText("DROP-1");
  await expect(target).toHaveAttribute("data-state", "empty");
});

test("dropping several files uses only the first", async ({ page }) => {
  await setup(page);
  await dragEvent(page, area(page), "drop", [xml("PRIMO"), xml("SECONDO")]);
  await expect(area(page)).toContainText("PRIMO.xml");
  await expect(area(page)).not.toContainText("SECONDO.xml");
  await page.getByRole("button", { name: "Carica" }).click();
  await expect(successText(page)).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(1);
});

test("dropping a non-file item is ignored", async ({ page }) => {
  await setup(page);
  await dragEvent(page, area(page), "drop");
  await expect(area(page)).toHaveAttribute("data-state", "empty");
});

test("dropping a .pdf shows today's error message", async ({ page }) => {
  await setup(page);
  await dragEvent(page, area(page), "drop", [
    { name: "fattura.pdf", type: "application/pdf", content: "%PDF-1.4" },
  ]);
  await expect(area(page)).toContainText("fattura.pdf");
  await page.getByRole("button", { name: "Carica" }).click();
  await expect(alertOf(page)).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(0);
});

test("dropping a file over 5 MB shows the size error and uploads nothing", async ({ page }) => {
  await setup(page);
  await dragEvent(page, area(page), "drop", [
    { name: "grande.xml", type: "application/xml", content: "a".repeat(5 * 1024 * 1024 + 1) },
  ]);
  await expect(area(page)).toContainText("grande.xml");
  await page.getByRole("button", { name: "Carica" }).click();
  await expect(alertOf(page)).toContainText("Il file supera la dimensione massima di 5 MB");
  await expect(page.locator("tbody tr")).toHaveCount(0);
});

test("sending without a file still shows Seleziona un file XML", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "Carica" }).click();
  await expect(alertOf(page)).toContainText("Seleziona un file XML");
});

test("a long accented name is truncated with an ellipsis", async ({ page }) => {
  await setup(page);
  const name = `${"fatturà molto lunga ".repeat(10)}.xml`;
  await dragEvent(page, area(page), "drop", [{ name, type: "application/xml", content: "<a/>" }]);
  const label = page.locator("#upload-file-name");
  await expect(label).toHaveText(name);
  await expect(label).toHaveCSS("text-overflow", "ellipsis");
});

test("the example link downloads fattura-esempio.xml, identical to the fixture", async ({
  page,
}) => {
  await setup(page);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "Scarica un esempio" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("fattura-esempio.xml");
  const path = await download.path();
  expect(readFileSync(path).equals(FIXTURE)).toBe(true);
});

test("the example is public: 200, XML, no redirect, identical to the fixture", async ({
  playwright,
  baseURL,
}) => {
  const anon = await playwright.request.newContext({ baseURL });
  const res = await anon.get("/esempi/fattura-esempio.xml", { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toMatch(/xml/);
  expect((await res.body()).equals(FIXTURE)).toBe(true);
  await anon.dispose();
});

test("the downloaded example uploads fine, and a second time is a duplicate", async ({
  page,
}) => {
  await setup(page);
  const upload = async () => {
    await page.getByLabel("File XML").setInputFiles({
      name: "fattura-esempio.xml",
      mimeType: "application/xml",
      buffer: FIXTURE,
    });
    await page.getByRole("button", { name: "Carica" }).click();
  };
  await upload();
  await expect(successText(page)).toBeVisible();
  await upload();
  await expect(alertOf(page)).toContainText("Questa fattura è già stata caricata");
});

test("no nested interactive elements and no console errors with click, drop and upload", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await setup(page);
  await expect(area(page).locator("a, button, [tabindex]")).toHaveCount(0);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), area(page).click()]);
  await chooser.setFiles([]);
  await dragEvent(page, area(page), "drop", [xml("CONS-1")]);
  await page.getByRole("button", { name: "Carica" }).click();
  await expect(successText(page)).toBeVisible();
  expect(errors).toEqual([]);
});

for (const key of ["Enter", "Space"]) {
  test(`${key} opens the file chooser exactly once`, async ({ page }) => {
    await setup(page);
    const input = page.getByLabel("File XML");
    await expect
      .poll(() =>
        input.evaluate((el) => Object.keys(el).some((k) => k.startsWith("__reactProps$"))),
      )
      .toBe(true);
    let opened = 0;
    page.on("filechooser", () => (opened += 1));
    await page.bringToFront();
    await input.focus();
    await expect(input).toBeFocused();
    await page.keyboard.press(key);
    await expect.poll(() => opened).toBeGreaterThanOrEqual(1);
    // Give a possible duplicate chooser time to appear.
    await page.waitForTimeout(500);
    expect(opened).toBe(1);
  });
}
