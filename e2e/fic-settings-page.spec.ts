import { randomInt } from "node:crypto";

import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

import { forTenant } from "@/db/tenant-scope";
import { formatDateTime } from "@/lib/format/date";

import { createTestTenant, type TestTenant, type TestUser } from "./helpers/create-test-tenant";
import { configureFakeFic, FAKE_FIC_URL, stateOf } from "./helpers/fake-fic/control";
import type { FakeFicScenario } from "./helpers/fake-fic/server";

/*
 * The page /impostazioni/fatture-in-cloud against the fake Fatture in Cloud: what each role
 * sees, the OAuth return messages and the guided actions (connect, choose, unlink).
 */

const SETTINGS = "/impostazioni/fatture-in-cloud";
const PAST = new Date("2026-01-01T00:00:00.000Z");

const byRole = (tenant: TestTenant, role: string) => tenant.users.find((u) => u.role === role)!;
const company = (name = "Azienda") => ({ id: randomInt(1, 2 ** 31), name: `${name} ${randomInt(1e6)}` });

async function setup({ module = true } = {}) {
  const tenant = await createTestTenant({ users: [{ role: "OWNER" }, { role: "ADMIN" }, { role: "USER" }] });
  if (module) await forTenant(tenant.tenantId).modules.activate("fic_iban_alert", { activatedAt: PAST });
  return tenant;
}

async function login(page: Page, user: TestUser) {
  const res = await page.request.post("/api/auth/login", { data: { email: user.email, password: user.password } });
  expect(res.status()).toBe(200);
}

/** A page of a new browser context, logged in as the user. */
async function openAs(browser: Browser, baseURL: string, user: TestUser) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await login(page, user);
  return page;
}

/** Console errors and uncaught exceptions of the page. */
function watchConsole(page: Page) {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  return problems;
}

/** Sets the fake's scenario as soon as the browser reaches the authorization page. */
async function scenarioOnAuthorize(page: Page, scenario: FakeFicScenario) {
  const authorizationUrls: string[] = [];
  await page.route(`${FAKE_FIC_URL}/oauth/authorize*`, async (route) => {
    const url = route.request().url();
    authorizationUrls.push(url);
    await configureFakeFic(stateOf(url), scenario);
    await route.continue();
  });
  return authorizationUrls;
}

/** Connects the tenant through the API (one company, or the given scenario) and returns the logged-in client. */
async function connectViaApi(client: APIRequestContext, scenario: FakeFicScenario) {
  const start = await client.post("/api/integrations/fic/connect");
  expect(start.status()).toBe(200);
  const { authorizationUrl } = await start.json();
  await configureFakeFic(stateOf(authorizationUrl), scenario);
  const authorize = await client.get(authorizationUrl, { maxRedirects: 0 });
  const callback = await client.get(authorize.headers().location, { maxRedirects: 0 });
  return new URL(callback.headers().location, "http://localhost").searchParams.get("esito");
}

const main = (page: Page) => page.getByRole("main");

test("OWNER, not connected: sees the state and the button; the click goes to the authorizationUrl and back connected", async ({
  page,
}) => {
  const problems = watchConsole(page);
  const tenant = await setup();
  await login(page, byRole(tenant, "OWNER"));
  const only = company("Unica");
  const authorizationUrls = await scenarioOnAuthorize(page, { companies: [only] });
  const connectCalls: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/integrations/fic/connect")) connectCalls.push(request.method());
  });

  await page.goto(SETTINGS);
  await expect(page.getByRole("heading", { name: "Fatture in Cloud" })).toBeVisible();
  await expect(page.getByText("Fatture in Cloud non collegato")).toBeVisible();
  // Double click: one call only.
  await page.getByRole("button", { name: "Collega Fatture in Cloud" }).dblclick();

  await expect(page).toHaveURL(new RegExp(`${SETTINGS}\\?esito=connected$`));
  expect(authorizationUrls).toHaveLength(1);
  expect(authorizationUrls[0].startsWith(`${FAKE_FIC_URL}/oauth/authorize?`)).toBe(true);
  expect(connectCalls).toEqual(["POST"]);
  await expect(page.getByRole("status")).toHaveText("Account Fatture in Cloud collegato");
  await expect(page.getByTestId("fic-headline")).toHaveText("Fatture in Cloud collegato");
  await expect(page.getByTestId("fic-company-name")).toHaveText(only.name);
  await expect(page.getByTestId("fic-company-id")).toHaveText(String(only.id));
  await expect(page.getByTestId("fic-connected-by")).toHaveText("E2E OWNER");
  await expect(page.getByRole("button", { name: "Collega Fatture in Cloud" })).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("connected: shows the date and time in the Europe/Rome zone and the Scollega button", async ({ page }) => {
  const tenant = await setup();
  const owner = byRole(tenant, "OWNER");
  await login(page, owner);
  const only = company();
  await connectViaApi(page.request, { companies: [only] });
  const resource = await (await page.request.get("/api/integrations/fic")).json();

  await page.goto(SETTINGS);
  const shown = await page.getByTestId("fic-connected-at").innerText();
  expect(shown).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
  expect(shown).toBe(formatDateTime(resource.connectedAt));
  await expect(page.getByRole("button", { name: "Scollega" })).toBeVisible();
});

test("a company with a long name and special characters is escaped, not interpreted", async ({ page }) => {
  const tenant = await setup();
  await login(page, byRole(tenant, "ADMIN"));
  const name = `<img src=x onerror="document.title='pwn'"> & "Rossi" <b>Figli</b> ${"lunghissimo ".repeat(25)}`.trim();
  await connectViaApi(page.request, { companies: [{ id: randomInt(1, 2 ** 31), name }] });

  await page.goto(SETTINGS);
  await expect(page.getByTestId("fic-company-name")).toHaveText(name);
  await expect(main(page).locator("img, b")).toHaveCount(0);
  await expect(page).not.toHaveTitle("pwn");
  // The long name does not widen the page beyond the viewport.
  const overflows = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflows).toBe(false);
});

test("two companies: the list with a button each; the choice leads to the connected state", async ({ page }) => {
  const problems = watchConsole(page);
  const tenant = await setup();
  await login(page, byRole(tenant, "OWNER"));
  const [first, second] = [company("Prima"), { id: randomInt(1, 2 ** 31), name: "Seconda & <i>Figli</i>" }];
  const authorizationUrls = await scenarioOnAuthorize(page, { companies: [first, second] });

  await page.goto(SETTINGS);
  await page.getByRole("button", { name: "Collega Fatture in Cloud" }).click();
  await expect(page).toHaveURL(new RegExp(`${SETTINGS}\\?esito=pending_company_selection$`));
  expect(authorizationUrls).toHaveLength(1);
  await expect(page.getByRole("status")).toHaveText("Scegli l'azienda di Fatture in Cloud da collegare");
  const items = page.getByRole("list", { name: "Aziende disponibili" }).getByRole("listitem");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText(first.name);
  await expect(items.nth(1)).toContainText("Seconda & <i>Figli</i>");
  await expect(page.getByRole("button", { name: "Collega questa azienda" })).toHaveCount(2);
  // Choosing is the only way ahead: no second "connect".
  await expect(page.getByRole("button", { name: "Collega Fatture in Cloud" })).toHaveCount(0);

  await items.nth(1).getByRole("button", { name: "Collega questa azienda" }).click();
  await expect(page.getByTestId("fic-headline")).toHaveText("Fatture in Cloud collegato");
  await expect(page.getByTestId("fic-company-name")).toHaveText("Seconda & <i>Figli</i>");
  await expect(page.getByTestId("fic-company-id")).toHaveText(String(second.id));
  await expect(page.getByRole("list", { name: "Aziende disponibili" })).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("a USER of the same tenant sees the state and no button, also while connected and while choosing", async ({
  browser,
  baseURL,
}) => {
  const tenant = await setup();
  const user = await openAs(browser, baseURL!, byRole(tenant, "USER"));
  const owner = await openAs(browser, baseURL!, byRole(tenant, "OWNER"));

  await user.goto(SETTINGS);
  await expect(user.getByText("Fatture in Cloud non collegato")).toBeVisible();
  await expect(main(user).getByRole("button")).toHaveCount(0);

  const [first, second] = [company("Prima"), company("Seconda")];
  expect(await connectViaApi(owner.request, { companies: [first, second] })).toBe("pending_company_selection");
  await user.reload();
  await expect(user.getByRole("list", { name: "Aziende disponibili" })).toHaveCount(0);
  await expect(main(user).getByRole("button")).toHaveCount(0);

  await owner.request.post("/api/integrations/fic/company", { data: { companyId: first.id } });
  await user.reload();
  await expect(user.getByTestId("fic-company-name")).toHaveText(first.name);
  await expect(main(user).getByRole("button")).toHaveCount(0);
});

test("unlinking asks for confirmation; cancelling keeps the link, confirming shows not connected", async ({ page }) => {
  const problems = watchConsole(page);
  const tenant = await setup();
  await login(page, byRole(tenant, "OWNER"));
  await connectViaApi(page.request, { companies: [company()] });

  await page.goto(SETTINGS);
  await page.getByRole("button", { name: "Scollega" }).click();
  await expect(page.getByText("Vuoi scollegare Fatture in Cloud?")).toBeVisible();
  await page.getByRole("button", { name: "Annulla" }).click();
  await expect(page.getByTestId("fic-headline")).toHaveText("Fatture in Cloud collegato");
  expect((await (await page.request.get("/api/integrations/fic")).json()).status).toBe("connected");

  await page.getByRole("button", { name: "Scollega" }).click();
  await page.getByRole("button", { name: "Conferma scollegamento" }).dblclick();
  await expect(page.getByTestId("fic-headline")).toHaveText("Fatture in Cloud non collegato");
  await expect(page.getByRole("button", { name: "Collega Fatture in Cloud" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Scollega" })).toHaveCount(0);
  await expect(main(page).getByRole("alert")).toHaveCount(0);
  expect((await (await page.request.get("/api/integrations/fic")).json()).status).toBe("not_connected");
  expect(problems).toEqual([]);
});

test("two tabs: unlinking in one and acting in the other shows the 409 message and the new state", async ({
  browser,
  baseURL,
}) => {
  const tenant = await setup();
  const owner = byRole(tenant, "OWNER");
  const tabA = await openAs(browser, baseURL!, owner);
  const tabB = await openAs(browser, baseURL!, owner);
  await connectViaApi(tabA.request, { companies: [company()] });
  await tabA.goto(SETTINGS);
  await tabB.goto(SETTINGS);
  await expect(tabB.getByRole("button", { name: "Scollega" })).toBeVisible();

  await tabA.getByRole("button", { name: "Scollega" }).click();
  await tabA.getByRole("button", { name: "Conferma scollegamento" }).click();
  await expect(tabA.getByTestId("fic-headline")).toHaveText("Fatture in Cloud non collegato");

  // Tab B still shows the old state: its click is refused with 409 and the page catches up.
  await tabB.getByRole("button", { name: "Scollega" }).click();
  await tabB.getByRole("button", { name: "Conferma scollegamento" }).click();
  await expect(main(tabB).getByRole("alert")).toHaveText("La tua azienda non è collegata a Fatture in Cloud");
  await expect(tabB.getByTestId("fic-headline")).toHaveText("Fatture in Cloud non collegato");
});

test("two tabs: connect in a tab that is already connected shows the 409 message and keeps the page", async ({
  browser,
  baseURL,
}) => {
  const tenant = await setup();
  const owner = byRole(tenant, "OWNER");
  const tabA = await openAs(browser, baseURL!, owner);
  const tabB = await openAs(browser, baseURL!, owner);
  await tabA.goto(SETTINGS);
  await tabB.goto(SETTINGS);
  await connectViaApi(tabA.request, { companies: [company("Altra")] });

  await tabB.getByRole("button", { name: "Collega Fatture in Cloud" }).click();
  await expect(main(tabB).getByRole("alert")).toHaveText("La tua azienda è già collegata a Fatture in Cloud");
  await expect(tabB.getByTestId("fic-headline")).toHaveText("Fatture in Cloud collegato");
  await expect(tabB.getByRole("button", { name: "Collega Fatture in Cloud" })).toHaveCount(0);
});

test("reauthorization_required: the expiry message, the company still shown and the connect button", async ({ page }) => {
  const tenant = await setup();
  await login(page, byRole(tenant, "OWNER"));
  const only = company();
  await connectViaApi(page.request, { companies: [only] });
  const scope = forTenant(tenant.tenantId);
  const tokens = (await scope.ficConnection.readTokens())!;
  const changed = await scope.ficConnection.requireReauthorizationIfUnchanged(
    { connectionId: tokens.connectionId, accessTokenEnc: tokens.accessTokenEnc!, refreshTokenEnc: tokens.refreshTokenEnc! },
    "refresh_rejected",
    new Date(),
  );
  expect(changed).toBe(true);

  await page.goto(SETTINGS);
  await expect(page.getByTestId("fic-headline")).toHaveText(
    "Il collegamento è scaduto o è stato revocato: ricollega l'account",
  );
  await expect(page.getByTestId("fic-company-name")).toHaveText(only.name);
  await expect(page.getByRole("button", { name: "Collega Fatture in Cloud" })).toBeVisible();
});

test("the return from the callback shows the message of each outcome with the right role", async ({ page }) => {
  const problems = watchConsole(page);
  const tenant = await setup();
  await login(page, byRole(tenant, "OWNER"));
  const cases: Array<[string, "status" | "alert", string]> = [
    ["connected", "status", "Account Fatture in Cloud collegato"],
    ["cancelled", "alert", "Collegamento annullato"],
    ["access_denied", "alert", "Collegamento annullato"],
    ["invalid_state", "alert", "Il link di collegamento non è valido o è scaduto. Riprova dalla pagina delle impostazioni"],
    [
      "token_exchange_failed",
      "alert",
      "Non è stato possibile completare il collegamento con Fatture in Cloud. Riprova",
    ],
    ["company_already_linked", "alert", "Questa azienda di Fatture in Cloud è già collegata a un altro account Vistato"],
    ["no_company", "alert", "Il tuo account Fatture in Cloud non ha nessuna azienda da collegare"],
  ];
  for (const [esito, role, message] of cases) {
    await page.goto(`${SETTINGS}?esito=${esito}`);
    await expect(page.getByRole(role).filter({ hasText: message }), esito).toHaveCount(1);
    await expect(page.getByTestId("esito"), esito).toHaveText(message);
  }
  expect(problems).toEqual([]);
});

test("a real callback refusal (the user denies on FiC) lands on the page with the message", async ({ page }) => {
  const tenant = await setup();
  await login(page, byRole(tenant, "OWNER"));
  await scenarioOnAuthorize(page, { authorize: "deny" });
  await page.goto(SETTINGS);
  await page.getByRole("button", { name: "Collega Fatture in Cloud" }).click();
  await expect(page).toHaveURL(new RegExp(`${SETTINGS}\\?esito=access_denied$`));
  await expect(main(page).getByRole("alert")).toHaveText("Collegamento annullato");
  await expect(page.getByText("Fatture in Cloud non collegato")).toBeVisible();
  await expect(page.getByRole("button", { name: "Collega Fatture in Cloud" })).toBeVisible();
});

test("an unknown, repeated or hostile esito shows nothing and is not reflected in the page", async ({ page }) => {
  const problems = watchConsole(page);
  const tenant = await setup();
  await login(page, byRole(tenant, "OWNER"));
  const hostile = "<script>document.title='xss'</script><b>ZZ-reflected</b>";
  for (const query of [
    `esito=${encodeURIComponent(hostile)}`,
    "esito=sconosciuto",
    "esito=__proto__",
    "esito=constructor",
    "esito=connected&esito=cancelled",
    "esito=",
    "esito=CONNECTED",
  ]) {
    await page.goto(`${SETTINGS}?${query}`);
    await expect(page.getByTestId("fic-headline"), query).toBeVisible();
    await expect(page.getByTestId("esito"), query).toHaveCount(0);
    await expect(page.getByRole("status"), query).toHaveCount(0);
    await expect(page.locator("main").getByRole("alert"), query).toHaveCount(0);
    // The visible page, not the raw HTML: Next puts the URL in its inert RSC payload.
    const text = await page.locator("body").innerText();
    expect(text, query).not.toContain("ZZ-reflected");
    expect(text, query).not.toContain("sconosciuto");
    await expect(main(page).locator("b, script"), query).toHaveCount(0);
    await expect(page).not.toHaveTitle("xss");
  }
  expect(problems).toEqual([]);
});

test("a tenant without the module sees the message and no button; the menu has no Impostazioni", async ({ page }) => {
  const tenant = await setup({ module: false });
  for (const role of ["OWNER", "USER"]) {
    await login(page, byRole(tenant, role));
    await page.goto(SETTINGS);
    await expect(page.getByText("Il modulo Alert cambio IBAN non è attivo per la tua azienda")).toBeVisible();
    await expect(main(page).getByRole("button")).toHaveCount(0);
    await expect(page.getByTestId("fic-headline")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Impostazioni" })).toHaveCount(0);
  }
});

test("without a session the page redirects to /login and comes back after the login", async ({ page }) => {
  const tenant = await setup();
  const owner = byRole(tenant, "OWNER");
  await page.goto(`${SETTINGS}?esito=cancelled`);
  await expect(page).toHaveURL(/\/login\?next=/);
  expect(new URL(page.url()).searchParams.get("next")).toBe(`${SETTINGS}?esito=cancelled`);

  await page.getByLabel("Email").fill(owner.email);
  await page.getByLabel("Password").fill(owner.password);
  await page.getByRole("button", { name: "Accedi" }).click();
  await expect(page).toHaveURL(`${SETTINGS}?esito=cancelled`);
  await expect(page.getByRole("heading", { name: "Fatture in Cloud" })).toBeVisible();
});

test("the Impostazioni menu entry follows the fic-integration link of GET /api, for every role", async ({ page }) => {
  const withModule = await setup();
  const without = await setup({ module: false });
  for (const [tenant, expected] of [
    [withModule, true],
    [without, false],
  ] as const) {
    for (const role of ["OWNER", "ADMIN", "USER"]) {
      await login(page, byRole(tenant, role));
      const api = await (await page.request.get("/api")).json();
      expect("fic-integration" in api._links, role).toBe(expected);
      await page.goto("/fatture");
      const entry = page.getByRole("navigation", { name: "Navigazione principale" }).getByRole("link", { name: "Impostazioni" });
      await expect(entry, role).toHaveCount(expected ? 1 : 0);
      if (expected) {
        await entry.click();
        await expect(page).toHaveURL(SETTINGS);
      }
    }
  }
});

test("tenants are isolated: the page shows only the company of the session's tenant", async ({ browser, baseURL }) => {
  const a = await setup();
  const b = await setup();
  const ownerA = await openAs(browser, baseURL!, byRole(a, "OWNER"));
  const ownerB = await openAs(browser, baseURL!, byRole(b, "OWNER"));
  const companyA = company("Tenant A");
  await connectViaApi(ownerA.request, { companies: [companyA] });
  await ownerA.goto(SETTINGS);
  await ownerB.goto(SETTINGS);
  await expect(ownerA.getByTestId("fic-company-name")).toHaveText(companyA.name);
  await expect(ownerB.getByText("Fatture in Cloud non collegato")).toBeVisible();
  await expect(ownerB.locator("body")).not.toContainText(companyA.name);
});
