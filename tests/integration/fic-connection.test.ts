import { createHash, randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getApi } from "@/app/api/route";
import { GET as getCallback } from "@/app/api/integrations/fic/callback/route";
import { POST as postCompany } from "@/app/api/integrations/fic/company/route";
import { POST as postConnect } from "@/app/api/integrations/fic/connect/route";
import { GET as getIntegration } from "@/app/api/integrations/fic/route";
import { createSession } from "@/db/auth";
import { createTenant, setTenantStatus } from "@/db/platform/tenants";
import { forTenant, type UserRole } from "@/db/tenant-scope";
import { decryptSecret, SecretDecryptionError } from "@/lib/crypto/secret-box";
import { createFicClient } from "@/lib/fic/client";
import { FIC_OAUTH_SCOPE, type FicOAuthConfig } from "@/lib/fic/oauth";
import {
  completeFicConnection,
  FIC_OAUTH_STATE_TTL_MS,
  startFicConnection,
  type FicConnectionCaller,
  type FicConnectionDeps,
} from "@/lib/fic-connection/service";
import { SlidingWindowRateLimiter } from "@/lib/fic/rate-limiter";

import { randomVatNumber } from "../../e2e/helpers/create-test-tenant";
import {
  FAKE_FIC_CLIENT_ID,
  FAKE_FIC_CLIENT_SECRET,
  startFakeFic,
  type FakeFic,
  type FakeFicScenario,
} from "../../e2e/helpers/fake-fic/server";
import { testDb, testSql } from "../helpers/db";

const BASE = "http://localhost:3100";
const REDIRECT_URI = `${BASE}/api/integrations/fic/callback`;
const PAST = new Date("2026-01-01T00:00:00.000Z");
const KEY = randomBytes(32).toString("base64");

let fake: FakeFic;
let config: FicOAuthConfig;

beforeAll(async () => {
  fake = await startFakeFic();
  config = {
    clientId: FAKE_FIC_CLIENT_ID,
    clientSecret: FAKE_FIC_CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    authorizeUrl: `${fake.url}/oauth/authorize`,
    tokenUrl: `${fake.url}/oauth/token`,
  };
});

afterAll(async () => {
  await fake?.close();
});

beforeEach(() => {
  vi.stubEnv("SECRETS_ENCRYPTION_KEY", KEY);
  vi.stubEnv("SECRETS_ENCRYPTION_KEY_PREVIOUS", "");
  vi.stubEnv("FIC_API_BASE_URL", fake.url);
  vi.stubEnv("FIC_OAUTH_AUTHORIZE_URL", config.authorizeUrl);
  vi.stubEnv("FIC_OAUTH_TOKEN_URL", config.tokenUrl);
  vi.stubEnv("FIC_CLIENT_ID", config.clientId);
  vi.stubEnv("FIC_CLIENT_SECRET", config.clientSecret);
  vi.stubEnv("FIC_REDIRECT_URI", REDIRECT_URI);
  vi.stubEnv("APP_ORIGIN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A FiC client towards the fake, one attempt only (no retry delays in the tests). */
const client = () =>
  createFicClient({
    baseUrl: fake.url,
    maxAttempts: 1,
    rateLimiter: new SlidingWindowRateLimiter({ maxRequests: 1000, windowMs: 1000 }),
  });

function deps(now?: Date): FicConnectionDeps {
  const ficClient = client();
  return { config, now: now ? () => now : undefined, listCompanies: (token) => ficClient.listCompanies(token) };
}

interface TestCaller extends FicConnectionCaller {
  token: string;
  role: UserRole;
}

let counter = 0;
async function makeTenant({ module = true } = {}) {
  const vatNumber = randomVatNumber();
  const tenant = await createTenant({ businessName: `T ${vatNumber}`, vatNumber }, testDb());
  if (module) await forTenant(tenant.id, testDb()).modules.activate("fic_iban_alert", { activatedAt: PAST });
  return tenant.id;
}

async function makeUser(tenantId: string, role: UserRole = "OWNER"): Promise<TestCaller> {
  counter += 1;
  const scope = forTenant(tenantId, testDb());
  const user = await scope.users.create({
    email: `fic${counter}-${randomBytes(3).toString("hex")}@example.com`,
    firstName: "Mario",
    lastName: role,
    role,
    status: "ACTIVE",
  });
  return { user: { id: user.id }, scope, token: await createSession(user.id, tenantId, testDb()), role };
}

const company = () => ({ id: 1 + (randomBytes(4).readUInt32BE() % 2_000_000_000), name: `Azienda ${counter++}` });

/** Follows the fake authorization page: the query the callback would receive. */
async function authorizeOnFake(authorizationUrl: string): Promise<URLSearchParams> {
  const res = await fetch(authorizationUrl, { redirect: "manual" });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location")!);
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
  return location.searchParams;
}

async function start(caller: FicConnectionCaller, scenario: FakeFicScenario = {}, now?: Date) {
  const result = await startFicConnection(caller, deps(now));
  if (!("authorizationUrl" in result)) throw new Error("expected an authorization URL");
  const state = new URL(result.authorizationUrl).searchParams.get("state")!;
  fake.setScenario(state, { companies: [company()], ...scenario });
  return { state, url: result.authorizationUrl };
}

const req = (path: string, token?: string, init: RequestInit = {}) =>
  new Request(`${BASE}${path}`, {
    ...init,
    headers: { ...(token ? { cookie: `vistato_session=${token}` } : {}), ...(init.headers as Record<string, string>) },
  });

async function counts() {
  const [row] = await testSql()`
    select (select count(*) from fic_connections)::int as connections,
           (select count(*) from fic_oauth_states)::int as states,
           (select count(*) from fic_oauth_states where used_at is null)::int as unused`;
  return row;
}

async function tenantCounts(tenantId: string) {
  const [row] = await testSql()`
    select (select count(*) from fic_connections where tenant_id = ${tenantId})::int as connections,
           (select count(*) from fic_oauth_states where tenant_id = ${tenantId})::int as states,
           (select count(*) from fic_oauth_states where tenant_id = ${tenantId} and used_at is null)::int as unused`;
  return row;
}

describe("authorization request (state + PKCE) in the database", () => {
  it("stores only the SHA-256 of the state and the verifier encrypted for the tenant, valid 10 minutes", async () => {
    const tenantId = await makeTenant();
    const otherTenant = await makeTenant();
    const owner = await makeUser(tenantId);
    const now = new Date("2026-11-01T10:00:00.000Z");
    const { state, url } = await start(owner, {}, now);

    const [row] = await testSql()`select * from fic_oauth_states`;
    expect(row.tenant_id).toBe(tenantId);
    expect(row.user_id).toBe(owner.user.id);
    expect(row.state_hash).toBe(createHash("sha256").update(state).digest("hex"));
    expect(row.expires_at.toISOString()).toBe(new Date(now.getTime() + FIC_OAUTH_STATE_TTL_MS).toISOString());
    expect(row.used_at).toBeNull();
    expect(JSON.stringify(row)).not.toContain(state);

    const verifier = decryptSecret(row.code_verifier_enc, { tenantId, purpose: "fic_pkce_verifier" }).plaintext;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new URL(url).searchParams.get("code_challenge")).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(() => decryptSecret(row.code_verifier_enc, { tenantId: otherTenant, purpose: "fic_pkce_verifier" })).toThrow(
      SecretDecryptionError,
    );
    expect(() => decryptSecret(row.code_verifier_enc, { tenantId, purpose: "fic_access_token" })).toThrow(
      SecretDecryptionError,
    );
  });

  it("accepts the state up to 1 ms before the 10 minutes and refuses it at 10 minutes exactly", async () => {
    const tenantId = await makeTenant();
    const owner = await makeUser(tenantId);
    const t0 = new Date("2026-11-01T10:00:00.000Z");
    const justBefore = new Date(t0.getTime() + FIC_OAUTH_STATE_TTL_MS - 1);
    const atExpiry = new Date(t0.getTime() + FIC_OAUTH_STATE_TTL_MS);

    const late = await start(owner, {}, t0);
    const lateQuery = await authorizeOnFake(late.url);
    expect(await completeFicConnection(owner, lateQuery, deps(atExpiry))).toBe("invalid_state");
    expect(fake.calls(late.state).token).toBe(0);
    expect((await counts()).connections).toBe(0);

    const inTime = await start(owner, {}, t0);
    expect(await completeFicConnection(owner, await authorizeOnFake(inTime.url), deps(justBefore))).toBe("connected");
  });

  it("deletes the tenant's expired states (used or not) when a new one is written, and nothing else", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const ownerA = await makeUser(tenantA);
    const ownerB = await makeUser(tenantB);
    const t0 = new Date("2026-11-01T10:00:00.000Z");
    const later = (ms: number) => new Date(t0.getTime() + ms);

    await start(ownerA, {}, t0); // expires at t0 + 10 min
    const used = await start(ownerA, {}, later(1000)); // expires at t0 + 10 min + 1 s
    await forTenant(tenantA, testDb()).ficOauthStates.consume(used.state, later(2000));
    await start(ownerB, {}, t0); // other tenant, expired too: not touched by A's writes
    expect((await counts()).states).toBe(3);

    // At t0 + 10 min the first one is expired (expires_at exclusive), the used one not yet.
    await start(ownerA, {}, later(FIC_OAUTH_STATE_TTL_MS));
    let rows = await testSql()`select tenant_id, expires_at from fic_oauth_states order by expires_at, tenant_id`;
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.tenant_id === tenantA)).toHaveLength(2);

    // Much later: everything of A but the new one is gone; B's expired one stays until B writes.
    await start(ownerA, {}, later(FIC_OAUTH_STATE_TTL_MS * 5));
    rows = await testSql()`select tenant_id, expires_at from fic_oauth_states`;
    expect(rows.filter((r) => r.tenant_id === tenantA)).toHaveLength(1);
    expect(rows.filter((r) => r.tenant_id === tenantB)).toHaveLength(1);
  });

  it("deletes the states of a deleted user (composite foreign key, cascade)", async () => {
    const tenantId = await makeTenant();
    const admin = await makeUser(tenantId, "ADMIN");
    await start(admin);
    await testSql()`delete from sessions where user_id = ${admin.user.id}`;
    expect(await forTenant(tenantId, testDb()).users.delete(admin.user.id)).toBe(true);
    expect((await counts()).states).toBe(0);
  });

  it("refuses a user of another tenant (composite foreign key)", async () => {
    const tenantA = await makeTenant();
    const tenantB = await makeTenant();
    const ownerB = await makeUser(tenantB);
    const scopeA = forTenant(tenantA, testDb());
    await expect(
      startFicConnection({ user: ownerB.user, scope: scopeA }, deps()),
    ).rejects.toMatchObject({ name: "UserNotInTenantError" });
    expect((await counts()).states).toBe(0);
  });
});

describe("callback", () => {
  it("saves the tokens encrypted with the tenant as AAD and the single company as connected", async () => {
    const tenantId = await makeTenant();
    const otherTenant = await makeTenant();
    const owner = await makeUser(tenantId);
    const only = company();
    const now = new Date("2026-11-01T10:00:00.000Z");
    const { state, url } = await start(owner, { companies: [only] }, now);

    expect(await completeFicConnection(owner, await authorizeOnFake(url), deps(now))).toBe("connected");
    const issued = fake.issuedTokens(state)!;
    const [row] = await testSql()`select * from fic_connections`;
    expect(row).toMatchObject({
      tenant_id: tenantId,
      status: "connected",
      company_name: only.name,
      available_companies: null,
      scopes: FIC_OAUTH_SCOPE,
      connected_by_user_id: owner.user.id,
    });
    expect(Number(row.fic_company_id)).toBe(only.id);
    expect(row.connected_at.toISOString()).toBe(now.toISOString());
    expect(row.access_token_expires_at.toISOString()).toBe(new Date(now.getTime() + 86400 * 1000).toISOString());
    const raw = JSON.stringify(row);
    expect(raw).not.toContain(issued.accessToken);
    expect(raw).not.toContain(issued.refreshToken);

    const ctx = (purpose: "fic_access_token" | "fic_refresh_token", t = tenantId) => ({ tenantId: t, purpose });
    expect(decryptSecret(row.access_token_enc, ctx("fic_access_token")).plaintext).toBe(issued.accessToken);
    expect(decryptSecret(row.refresh_token_enc, ctx("fic_refresh_token")).plaintext).toBe(issued.refreshToken);
    // Bound to the tenant and the purpose: copied elsewhere or read as the other token, they do not decrypt.
    expect(() => decryptSecret(row.access_token_enc, ctx("fic_access_token", otherTenant))).toThrow(SecretDecryptionError);
    expect(() => decryptSecret(row.access_token_enc, ctx("fic_refresh_token"))).toThrow(SecretDecryptionError);
    expect(() => decryptSecret(row.refresh_token_enc, ctx("fic_access_token"))).toThrow(SecretDecryptionError);

    // The data layer never hands out the tokens.
    const connection = await forTenant(tenantId, testDb()).ficConnection.get();
    expect(JSON.stringify(connection)).not.toMatch(/token_enc|TokenEnc|a\/fake|r\/fake/);
    expect(await forTenant(otherTenant, testDb()).ficConnection.get()).toBeNull();
  });

  it("with several companies saves pending_company_selection with the distinct choices", async () => {
    const tenantId = await makeTenant();
    const owner = await makeUser(tenantId);
    const [a, b] = [company(), company()];
    const { url } = await start(owner, { companies: [a, b, { ...a, name: "Duplicato" }] });
    expect(await completeFicConnection(owner, await authorizeOnFake(url), deps())).toBe("pending_company_selection");
    const connection = await forTenant(tenantId, testDb()).ficConnection.get();
    expect(connection).toMatchObject({ status: "pending_company_selection", companyId: null, connectedAt: null });
    expect(connection!.availableCompanies).toEqual([a, b]);
  });

  it("of two concurrent callbacks with the same state only one succeeds, FiC is called once", async () => {
    const tenantId = await makeTenant();
    const owner = await makeUser(tenantId);
    const { state, url } = await start(owner);
    const query = await authorizeOnFake(url);
    const outcomes = await Promise.all([
      completeFicConnection(owner, query, deps()),
      completeFicConnection(owner, query, deps()),
    ]);
    expect(outcomes.sort()).toEqual(["connected", "invalid_state"]);
    expect(fake.calls(state).token).toBe(1);
    expect((await counts()).connections).toBe(1);
  });

  it("of two tenants linking the same company at the same time only one succeeds (unique constraint)", async () => {
    const shared = company();
    const owners = await Promise.all([makeTenant(), makeTenant()].map(async (t) => makeUser(await t)));
    const queries: URLSearchParams[] = [];
    for (const owner of owners) queries.push(await authorizeOnFake((await start(owner, { companies: [shared] })).url));
    const outcomes = await Promise.all(owners.map((owner, i) => completeFicConnection(owner, queries[i], deps())));
    expect(outcomes.sort()).toEqual(["company_already_linked", "connected"]);
    const rows = await testSql()`select fic_company_id from fic_connections`;
    expect(rows.map((r) => Number(r.fic_company_id))).toEqual([shared.id]);
  });

  it("an OWNER's state used by an ADMIN of the same tenant is refused and spent", async () => {
    const tenantId = await makeTenant();
    const owner = await makeUser(tenantId, "OWNER");
    const admin = await makeUser(tenantId, "ADMIN");
    const { state, url } = await start(owner);
    const query = await authorizeOnFake(url);
    expect(await completeFicConnection(admin, query, deps())).toBe("invalid_state");
    expect(await completeFicConnection(owner, query, deps())).toBe("invalid_state");
    expect(fake.calls(state).token).toBe(0);
    expect(await counts()).toEqual({ connections: 0, states: 1, unused: 0 });
  });

  it("a state of another tenant is unknown there and stays usable by its owner", async () => {
    const ownerA = await makeUser(await makeTenant());
    const ownerB = await makeUser(await makeTenant());
    const { url } = await start(ownerA);
    const query = await authorizeOnFake(url);
    expect(await completeFicConnection(ownerB, query, deps())).toBe("invalid_state");
    expect((await counts()).unused).toBe(1);
    expect(await completeFicConnection(ownerA, query, deps())).toBe("connected");
  });

  it("a missing, empty, repeated, too long, strange or unknown state is refused before anything, without calling FiC", async () => {
    for (const [label, stateQuery] of [
      ["missing", ""],
      ["empty", "state="],
      ["repeated", "state=__S__&state=__S__"],
      ["too long", `state=${"a".repeat(10_000)}`],
      ["with strange characters", "state=%00%0D%0A%3Cscript%3E%F0%9F%98%80"],
      ["well formed but unknown", `state=${"A".repeat(43)}`],
    ]) {
      const owner = await makeUser(await makeTenant());
      const { state, url } = await start(owner);
      const code = (await authorizeOnFake(url)).get("code")!;
      const query = new URLSearchParams(`code=${encodeURIComponent(code)}&${stateQuery.replaceAll("__S__", state)}`);
      expect(await completeFicConnection(owner, query, deps()), label).toBe("invalid_state");
      expect(fake.calls(state).token, label).toBe(0);
      expect((await counts()).connections, label).toBe(0);
    }
  });

  it("a missing, too long or strange code spends the state and is not sent to FiC (token_exchange_failed)", async () => {
    for (const [label, code] of [
      ["missing", null],
      ["too long", "c".repeat(2049)],
      ["with a space", "abc def"],
      ["with CR/LF", "abc\r\nX-Injected: 1"],
      ["with non-ASCII characters", "còdice😀"],
    ] as [string, string | null][]) {
      const tenantId = await makeTenant();
      const owner = await makeUser(tenantId);
      const { state, url } = await start(owner);
      const query = await authorizeOnFake(url);
      if (code === null) query.delete("code");
      else query.set("code", code);
      expect(await completeFicConnection(owner, query, deps()), label).toBe("token_exchange_failed");
      expect(fake.calls(state).token, label).toBe(0);
      expect(await tenantCounts(tenantId), label).toEqual({ connections: 0, states: 1, unused: 0 });
    }
  });

  it("access_denied or another FiC error spends the state and saves nothing", async () => {
    const owner = await makeUser(await makeTenant());
    const denied = await start(owner, { authorize: "deny" });
    expect(await completeFicConnection(owner, await authorizeOnFake(denied.url), deps())).toBe("access_denied");
    const failed = await start(owner, { authorize: { error: "server_error" } });
    expect(await completeFicConnection(owner, await authorizeOnFake(failed.url), deps())).toBe("authorization_failed");
    expect(await counts()).toEqual({ connections: 0, states: 2, unused: 0 });
    expect(fake.calls(denied.state).token + fake.calls(failed.state).token).toBe(0);
  });

  it("a token exchange answered 400, 500, an invalid 200 or a redirect saves nothing (token_exchange_failed)", async () => {
    for (const [label, token] of [
      ["400 invalid_grant", { status: 400, body: JSON.stringify({ error: "invalid_grant" }) }],
      ["500", { status: 500 }],
      [
        "200 without refresh token",
        { status: 200, body: JSON.stringify({ token_type: "bearer", access_token: "a/x", expires_in: 60 }) },
      ],
      ["200 not JSON", { status: 200, body: "<html>" }],
      ["200 with a text content type", { status: 200, contentType: "text/plain", body: "{}" }],
      ["redirect", { status: 302, body: "" }],
    ] as [string, FakeFicScenario["token"]][]) {
      const owner = await makeUser(await makeTenant());
      const { state, url } = await start(owner, { token });
      expect(await completeFicConnection(owner, await authorizeOnFake(url), deps()), label).toBe("token_exchange_failed");
      expect(fake.calls(state), label).toMatchObject({ token: 1, companies: 0 });
      expect((await counts()).connections, label).toBe(0);
    }
  });

  it("an empty /user/companies gives no_company; a failing or invalid one companies_failed; nothing saved", async () => {
    const owner = await makeUser(await makeTenant());
    const empty = await start(owner, { companies: [] });
    expect(await completeFicConnection(owner, await authorizeOnFake(empty.url), deps())).toBe("no_company");
    for (const companiesResponse of [
      { status: 500 },
      { status: 200, body: JSON.stringify({ data: { companies: [{ id: "x", name: "A" }] } }) },
      { status: 200, body: JSON.stringify({ data: { companies: [{ id: 5, name: "A\u0000B" }] } }) },
    ]) {
      const failed = await start(owner, { companiesResponse });
      expect(await completeFicConnection(owner, await authorizeOnFake(failed.url), deps())).toBe("companies_failed");
    }
    expect((await counts()).connections).toBe(0);
  });

  it("a tenant connected meanwhile gets already_connected without calling FiC", async () => {
    const tenantId = await makeTenant();
    const owner = await makeUser(tenantId);
    const admin = await makeUser(tenantId, "ADMIN");
    const first = await start(owner);
    const second = await start(admin);
    expect(await completeFicConnection(owner, await authorizeOnFake(first.url), deps())).toBe("connected");
    expect(await completeFicConnection(admin, await authorizeOnFake(second.url), deps())).toBe("already_connected");
    expect(fake.calls(second.state).token).toBe(0);
  });
});

describe("company selection", () => {
  async function pending(choices = [company(), company()]) {
    const tenantId = await makeTenant();
    const owner = await makeUser(tenantId);
    const { url } = await start(owner, { companies: choices });
    expect(await completeFicConnection(owner, await authorizeOnFake(url), deps())).toBe("pending_company_selection");
    return { tenantId, owner, choices };
  }

  it("of two tenants choosing the same company at the same time one connects, the other's tokens are discarded", async () => {
    const shared = company();
    const a = await pending([shared, company()]);
    const b = await pending([company(), shared]);
    const results = await Promise.all([a, b].map(({ tenantId }) => forTenant(tenantId, testDb()).ficConnection.selectCompany(shared.id)));
    expect(results.map((r) => r.outcome).sort()).toEqual(["company_already_linked", "connected"]);
    const rows = await testSql()`select tenant_id, status, fic_company_id from fic_connections`;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].fic_company_id)).toBe(shared.id);
  });

  it("two concurrent choices of the same tenant: one connects, the other finds nothing pending", async () => {
    const { tenantId, choices } = await pending();
    const scope = forTenant(tenantId, testDb());
    const results = await Promise.all(choices.map((c) => scope.ficConnection.selectCompany(c.id)));
    expect(results.map((r) => r.outcome).sort()).toEqual(["connected", "not_pending"]);
  });

  it("an id outside the saved list, or a tenant not pending, changes nothing", async () => {
    const { tenantId, choices } = await pending();
    const scope = forTenant(tenantId, testDb());
    const before = await scope.ficConnection.get();
    expect((await scope.ficConnection.selectCompany(choices[0].id + 1)).outcome).toBe("unknown_company");
    expect(await scope.ficConnection.get()).toEqual(before);
    const other = forTenant(await makeTenant(), testDb());
    expect((await other.ficConnection.selectCompany(choices[0].id)).outcome).toBe("not_pending");
    expect(await other.ficConnection.get()).toBeNull();
  });
});

describe("routes", () => {
  it("connect answers 503 fic_not_configured without the OAuth variables or the encryption key", async () => {
    const owner = await makeUser(await makeTenant());
    for (const name of ["FIC_CLIENT_ID", "FIC_CLIENT_SECRET", "FIC_REDIRECT_URI", "SECRETS_ENCRYPTION_KEY"]) {
      vi.stubEnv(name, "");
      const res = await postConnect(req("/api/integrations/fic/connect", owner.token, { method: "POST" }));
      expect(res.status, name).toBe(503);
      expect((await res.json()).error).toBe("fic_not_configured");
      vi.stubEnv(name, name === "SECRETS_ENCRYPTION_KEY" ? KEY : name === "FIC_REDIRECT_URI" ? REDIRECT_URI : "x");
    }
    expect((await counts()).states).toBe(0);
  });

  it("full flow through the routes: connect, callback 303 to the settings, resource without secrets", async () => {
    const tenantId = await makeTenant();
    const owner = await makeUser(tenantId);
    const res = await postConnect(req("/api/integrations/fic/connect", owner.token, { method: "POST" }));
    expect(res.status).toBe(200);
    const { authorizationUrl } = await res.json();
    const state = new URL(authorizationUrl).searchParams.get("state")!;
    const only = company();
    fake.setScenario(state, { companies: [only] });
    const query = await authorizeOnFake(authorizationUrl);

    const cb = await getCallback(req(`/api/integrations/fic/callback?${query}`, owner.token));
    expect(cb.status).toBe(303);
    expect(cb.headers.get("location")).toBe("/impostazioni/fatture-in-cloud?esito=connected");
    expect(cb.headers.get("referrer-policy")).toBe("no-referrer");

    const body = await (await getIntegration(req("/api/integrations/fic", owner.token))).json();
    expect(body).toMatchObject({ status: "connected", companyId: only.id, companyName: only.name });
    expect(JSON.stringify(body)).not.toContain(fake.issuedTokens(state)!.accessToken);
    const again = await postConnect(req("/api/integrations/fic/connect", owner.token, { method: "POST" }));
    expect(again.status).toBe(409);
  });

  it("a user disabled or back to invited between connect and callback is sent to the login, the state stays unused", async () => {
    for (const status of ["DISABLED", "INVITED"] as const) {
      const tenantId = await makeTenant();
      const owner = await makeUser(tenantId);
      const { state, url } = await start(owner);
      const query = await authorizeOnFake(url);
      await forTenant(tenantId, testDb()).users.update(owner.user.id, { status });
      const cb = await getCallback(req(`/api/integrations/fic/callback?${query}`, owner.token));
      expect(cb.status, status).toBe(303);
      expect(cb.headers.get("location")).toBe("/login?next=%2Fimpostazioni%2Ffatture-in-cloud");
      expect(fake.calls(state).token).toBe(0);
      expect(await tenantCounts(tenantId), status).toEqual({ connections: 0, states: 1, unused: 1 });
    }
  });

  it("a tenant suspended or closed between connect and callback: login, nothing saved", async () => {
    for (const status of ["SUSPENDED", "CLOSED"] as const) {
      const tenantId = await makeTenant();
      const owner = await makeUser(tenantId);
      const { url } = await start(owner);
      const query = await authorizeOnFake(url);
      await setTenantStatus(tenantId, status, testDb());
      const cb = await getCallback(req(`/api/integrations/fic/callback?${query}`, owner.token));
      expect(cb.status, status).toBe(303);
      expect(cb.headers.get("location"), status).toMatch(/^\/login/);
      expect((await counts()).connections, status).toBe(0);
    }
  });

  it("a module cancelled or a role lowered to USER between connect and callback: 403, nothing saved", async () => {
    const tenantId = await makeTenant();
    const owner = await makeUser(tenantId);
    const admin = await makeUser(tenantId, "ADMIN");
    const first = await authorizeOnFake((await start(admin)).url);
    await forTenant(tenantId, testDb()).users.update(admin.user.id, { role: "USER" });
    const demoted = await getCallback(req(`/api/integrations/fic/callback?${first}`, admin.token));
    expect(demoted.status).toBe(403);
    expect((await demoted.json()).error).toBe("forbidden");

    const second = await authorizeOnFake((await start(owner)).url);
    await forTenant(tenantId, testDb()).modules.cancel("fic_iban_alert");
    const cancelled = await getCallback(req(`/api/integrations/fic/callback?${second}`, owner.token));
    expect(cancelled.status).toBe(403);
    expect((await cancelled.json()).error).toBe("module_not_active");
    expect((await counts()).connections).toBe(0);
  });

  it("GET /api links fic-integration only for a tenant with the module", async () => {
    const withModule = await makeUser(await makeTenant(), "USER");
    const without = await makeUser(await makeTenant({ module: false }), "OWNER");
    expect((await (await getApi(req("/api", withModule.token))).json())._links["fic-integration"]).toEqual({
      href: "/api/integrations/fic",
      title: "Fatture in Cloud",
    });
    expect((await (await getApi(req("/api", without.token))).json())._links).not.toHaveProperty("fic-integration");
    expect((await (await getApi(req("/api"))).json())._links).not.toHaveProperty("fic-integration");
  });

  it("POST company: body over 1 KB is 413, invalid JSON 400, not pending 409", async () => {
    const owner = await makeUser(await makeTenant());
    const post = (body: string) =>
      postCompany(req("/api/integrations/fic/company", owner.token, { method: "POST", body, headers: { "content-type": "application/json" } }));
    expect((await post(JSON.stringify({ companyId: 1, pad: "x".repeat(2000) }))).status).toBe(413);
    expect((await post("{not json")).status).toBe(400);
    expect((await post(JSON.stringify({ companyId: 1.5 }))).status).toBe(400);
    const notPending = await post(JSON.stringify({ companyId: 1 }));
    expect(notPending.status).toBe(409);
    expect((await notPending.json()).error).toBe("company_selection_not_pending");
  });
});
