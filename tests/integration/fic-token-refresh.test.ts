import { randomBytes } from "node:crypto";

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as postConnect } from "@/app/api/integrations/fic/connect/route";
import { DELETE as deleteIntegration, GET as getIntegration } from "@/app/api/integrations/fic/route";
import { createSession } from "@/db/auth";
import { getSql } from "@/db/client";
import { requireTestDatabaseUrl } from "@/db/migrate";
import { createTenant } from "@/db/platform/tenants";
import { forTenant, type UserRole } from "@/db/tenant-scope";
import { decryptSecret, SecretDecryptionError } from "@/lib/crypto/secret-box";
import {
  createFicAccessTokenProvider,
  FIC_ACCESS_TOKEN_REFRESH_MARGIN_MS,
  FIC_MAX_CONCURRENT_RENEWALS,
  FIC_RENEWAL_BACKOFF_MS,
  FIC_RENEWAL_FAILURE_THRESHOLD,
  type FicAccessTokenDeps,
  FicNotConnectedError,
  FicReauthorizationRequiredError,
  FicTokenRefreshFailedError,
  FicTokenRefreshUnavailableError,
  FicTokenUnreadableError,
  getFicAccessToken,
} from "@/lib/fic/access-token";
import { createFicClient } from "@/lib/fic/client";
import type { FicLogEntry } from "@/lib/fic/log";
import type { FicOAuthConfig } from "@/lib/fic/oauth";
import { SlidingWindowRateLimiter } from "@/lib/fic/rate-limiter";
import {
  completeFicConnection,
  disconnectFic,
  startFicConnection,
  type FicConnectionCaller,
  type FicConnectionDeps,
} from "@/lib/fic-connection/service";

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
const T0 = new Date("2026-11-01T10:00:00.000Z");
/** Lifetime of the access tokens issued by the fake in these tests: one hour. */
const EXPIRES_IN = 3600;
const EXPIRY = new Date(T0.getTime() + EXPIRES_IN * 1000);
const at = (ms: number) => new Date(T0.getTime() + ms);
/** Long after the expiry of the first token. */
const LATER = at(2 * EXPIRES_IN * 1000);

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
    revokeUrl: `${fake.url}/oauth/revoke`,
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
  vi.stubEnv("FIC_OAUTH_REVOKE_URL", config.revokeUrl!);
  vi.stubEnv("FIC_CLIENT_ID", config.clientId);
  vi.stubEnv("FIC_CLIENT_SECRET", config.clientSecret);
  vi.stubEnv("FIC_REDIRECT_URI", REDIRECT_URI);
  vi.stubEnv("APP_ORIGIN", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function connectionDeps(now: Date): FicConnectionDeps {
  const ficClient = createFicClient({
    baseUrl: fake.url,
    maxAttempts: 1,
    rateLimiter: new SlidingWindowRateLimiter({ maxRequests: 1000, windowMs: 1000 }),
  });
  return { config, now: () => now, listCompanies: (token) => ficClient.listCompanies(token) };
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
    email: `ficr${counter}-${randomBytes(3).toString("hex")}@example.com`,
    firstName: "Mario",
    lastName: role,
    role,
    status: "ACTIVE",
  });
  return { user: { id: user.id }, scope, token: await createSession(user.id, tenantId, testDb()), role };
}

const company = () => ({ id: 1 + (randomBytes(4).readUInt32BE() % 2_000_000_000), name: `Azienda ${counter++}` });

async function authorizeOnFake(authorizationUrl: string): Promise<URLSearchParams> {
  const res = await fetch(authorizationUrl, { redirect: "manual" });
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location")!).searchParams;
}

/** Links the owner's tenant through the real OAuth flow at `now`; one company unless given. */
async function link(owner: TestCaller, scenario: FakeFicScenario = {}, now = T0) {
  const started = await startFicConnection(owner, connectionDeps(now));
  if (!("authorizationUrl" in started)) throw new Error("expected an authorization URL");
  const state = new URL(started.authorizationUrl).searchParams.get("state")!;
  const companies = scenario.companies ?? [company()];
  fake.setScenario(state, { expiresIn: EXPIRES_IN, ...scenario, companies });
  const outcome = await completeFicConnection(owner, await authorizeOnFake(started.authorizationUrl), connectionDeps(now));
  return { state, outcome, companies, issued: fake.issuedTokens(state)! };
}

/** A tenant with an OWNER, linked to one company at T0 (access token valid until T0 + 1 hour). */
async function connectedTenant(scenario: FakeFicScenario = {}) {
  const tenantId = await makeTenant();
  const owner = await makeUser(tenantId);
  const linked = await link(owner, scenario);
  expect(linked.outcome).toBe("connected");
  /** Changes what the fake does from now on for this link (refresh, revocation). */
  const configure = (next: FakeFicScenario) =>
    fake.setScenario(linked.state, { expiresIn: EXPIRES_IN, companies: linked.companies, ...next });
  return { tenantId, owner, ...linked, configure };
}

async function row(tenantId: string) {
  const [found] = await testSql()`select * from fic_connections where tenant_id = ${tenantId}`;
  return found;
}

const decryptAs = (tenantId: string, value: string, purpose: "fic_access_token" | "fic_refresh_token") =>
  decryptSecret(value, { tenantId, purpose }).plaintext;

/** Collects the log entries of a call; `text()` is everything that was logged. */
function logs() {
  const entries: FicLogEntry[] = [];
  return { entries, log: (entry: FicLogEntry) => void entries.push(entry), text: () => JSON.stringify(entries) };
}

function deps(now: Date, extra: FicAccessTokenDeps = {}): FicAccessTokenDeps {
  return { now: () => now, log: () => {}, ...extra };
}

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const req = (path: string, token?: string, init: RequestInit = {}) =>
  new Request(`${BASE}${path}`, {
    ...init,
    headers: { ...(token ? { cookie: `vistato_session=${token}` } : {}), ...(init.headers as Record<string, string>) },
  });

describe("getFicAccessToken: margin of 60 seconds", () => {
  it("returns the stored token without calling FiC when it expires in more than 60 seconds (60 s + 1 ms)", async () => {
    const { tenantId, state, issued } = await connectedTenant();
    for (const now of [T0, at(EXPIRES_IN * 1000 - FIC_ACCESS_TOKEN_REFRESH_MARGIN_MS - 1)]) {
      expect(await getFicAccessToken(tenantId, deps(now))).toBe(issued.accessToken);
    }
    expect(fake.tokenCalls(state).refresh).toBe(0);
  });

  it("renews a token that expires in exactly 60 seconds (boundary included)", async () => {
    const { tenantId, state, issued } = await connectedTenant();
    const boundary = new Date(EXPIRY.getTime() - FIC_ACCESS_TOKEN_REFRESH_MARGIN_MS);
    const token = await getFicAccessToken(tenantId, deps(boundary));
    expect(token).not.toBe(issued.accessToken);
    expect(token).toBe(fake.issuedTokens(state)!.accessToken);
    expect(fake.tokenCalls(state).refresh).toBe(1);
    expect((await row(tenantId)).access_token_expires_at.toISOString()).toBe(
      new Date(boundary.getTime() + EXPIRES_IN * 1000).toISOString(),
    );
  });
});

describe("getFicAccessToken: renewal", () => {
  it("renews an expired token, saving encrypted (AAD = tenant) the new access token, the rotated refresh token and the new expiry", async () => {
    const { tenantId, state, issued } = await connectedTenant();
    const other = await makeTenant();
    const before = await row(tenantId);

    const token = await getFicAccessToken(tenantId, deps(LATER));
    const latest = fake.issuedTokens(state)!;
    expect(token).toBe(latest.accessToken);
    expect(latest.refreshToken).not.toBe(issued.refreshToken);

    const after = await row(tenantId);
    expect(decryptAs(tenantId, after.access_token_enc, "fic_access_token")).toBe(latest.accessToken);
    expect(decryptAs(tenantId, after.refresh_token_enc, "fic_refresh_token")).toBe(latest.refreshToken);
    expect(after.access_token_expires_at.toISOString()).toBe(new Date(LATER.getTime() + EXPIRES_IN * 1000).toISOString());
    expect(after).toMatchObject({ status: "connected", last_refresh_error: null, last_refresh_error_at: null });
    expect(after.access_token_enc).not.toBe(before.access_token_enc);
    expect(() => decryptAs(other, after.access_token_enc, "fic_access_token")).toThrow(SecretDecryptionError);
    const raw = JSON.stringify(after);
    for (const secret of [latest.accessToken, latest.refreshToken, issued.accessToken]) expect(raw).not.toContain(secret);

    // The new token is the one in use: no second renewal until it is about to expire.
    expect(await getFicAccessToken(tenantId, deps(at(2 * EXPIRES_IN * 1000 + 1000)))).toBe(token);
    expect(fake.tokenCalls(state).refresh).toBe(1);
    // The rotated refresh token is the one sent next time (the fake refuses the old one).
    const third = await getFicAccessToken(tenantId, deps(at(4 * EXPIRES_IN * 1000)));
    expect(third).toBe(fake.issuedTokens(state)!.accessToken);
    expect((await row(tenantId)).status).toBe("connected");
  });

  it("keeps the old refresh token when FiC does not send a new one", async () => {
    const { tenantId, state, issued, configure } = await connectedTenant();
    configure({ rotateRefreshToken: false });
    const before = await row(tenantId);

    const token = await getFicAccessToken(tenantId, deps(LATER));
    expect(token).not.toBe(issued.accessToken);
    const after = await row(tenantId);
    expect(after.refresh_token_enc).toBe(before.refresh_token_enc);
    expect(decryptAs(tenantId, after.refresh_token_enc, "fic_refresh_token")).toBe(issued.refreshToken);
    expect(decryptAs(tenantId, after.access_token_enc, "fic_access_token")).toBe(token);

    // Still accepted by FiC at the next renewal.
    await getFicAccessToken(tenantId, deps(at(4 * EXPIRES_IN * 1000)));
    expect(fake.tokenCalls(state).refresh).toBe(2);
    expect((await row(tenantId)).status).toBe("connected");
  });

  it("10 concurrent calls with an expired token: FiC receives one refresh request and all get the same new token", async () => {
    const { tenantId, state, configure } = await connectedTenant();
    configure({ refreshDelayMs: 300 });
    const tokens = await Promise.all(Array.from({ length: 10 }, () => getFicAccessToken(tenantId, deps(LATER))));
    expect(fake.tokenCalls(state).refresh).toBe(1);
    expect(new Set(tokens)).toEqual(new Set([fake.issuedTokens(state)!.accessToken]));
  });

  it("10 concurrent calls from 10 providers (like 10 processes): the row lock lets one refresh, the others reuse its token", async () => {
    const { tenantId, state, configure } = await connectedTenant();
    configure({ refreshDelayMs: 300 });
    const providers = Array.from({ length: 10 }, () => createFicAccessTokenProvider());
    const tokens = await Promise.all(providers.map((provider) => provider(tenantId, deps(LATER))));
    expect(fake.tokenCalls(state).refresh).toBe(1);
    expect(new Set(tokens)).toEqual(new Set([fake.issuedTokens(state)!.accessToken]));
    expect(decryptAs(tenantId, (await row(tenantId)).access_token_enc, "fic_access_token")).toBe(tokens[0]);
  });

  it("concurrent renewals of two tenants do not wait for each other and each gets its own token", async () => {
    const a = await connectedTenant();
    const b = await connectedTenant();
    a.configure({ refreshDelayMs: 300 });
    b.configure({ refreshDelayMs: 300 });
    const [tokenA, tokenB] = await Promise.all([
      getFicAccessToken(a.tenantId, deps(LATER)),
      getFicAccessToken(b.tenantId, deps(LATER)),
    ]);
    expect(tokenA).toBe(fake.issuedTokens(a.state)!.accessToken);
    expect(tokenB).toBe(fake.issuedTokens(b.state)!.accessToken);
    expect([fake.tokenCalls(a.state).refresh, fake.tokenCalls(b.state).refresh]).toEqual([1, 1]);
  });
});

describe("getFicAccessToken: refresh refused for good", () => {
  it("invalid_grant: reauthorization_required, tokens deleted, FicReauthorizationRequiredError, resource with the state and connect for OWNER/ADMIN", async () => {
    const { tenantId, owner, state, companies, issued, configure } = await connectedTenant();
    const admin = await makeUser(tenantId, "ADMIN");
    const user = await makeUser(tenantId, "USER");
    configure({ refresh: "invalid_grant" });
    const captured = logs();

    await expect(getFicAccessToken(tenantId, deps(LATER, { log: captured.log }))).rejects.toBeInstanceOf(
      FicReauthorizationRequiredError,
    );
    const after = await row(tenantId);
    expect(after).toMatchObject({
      status: "reauthorization_required",
      access_token_enc: null,
      refresh_token_enc: null,
      access_token_expires_at: null,
      last_refresh_error: "refresh_rejected",
      company_name: companies[0].name,
    });
    expect(after.last_refresh_error_at.toISOString()).toBe(LATER.toISOString());
    expect(Number(after.fic_company_id)).toBe(companies[0].id);
    expect(captured.entries.map((e) => e.event)).toContain("fic_token_refresh_rejected");
    expect(captured.text()).not.toContain(issued.refreshToken);
    expect(captured.text()).not.toContain(issued.accessToken);

    for (const manager of [owner, admin]) {
      const body = await (await getIntegration(req("/api/integrations/fic", manager.token))).json();
      expect(body).toMatchObject({ status: "reauthorization_required", companyId: companies[0].id, companyName: companies[0].name });
      expect(body._links.connect).toEqual({ href: "/api/integrations/fic/connect", method: "POST", title: "Collega Fatture in Cloud" });
      expect(body._links.disconnect).toMatchObject({ method: "DELETE" });
    }
    const forUser = await (await getIntegration(req("/api/integrations/fic", user.token))).json();
    expect(forUser.status).toBe("reauthorization_required");
    expect(Object.keys(forUser._links)).toEqual(["self"]);

    // Later calls fail at once, without asking FiC again.
    await expect(getFicAccessToken(tenantId, deps(LATER))).rejects.toBeInstanceOf(FicReauthorizationRequiredError);
    expect(fake.tokenCalls(state).refresh).toBe(1);
  });

  it("a 400 or 401 without an OAuth code is a refusal too; invalid_client (Vistato's configuration) changes nothing", async () => {
    for (const refresh of [
      { status: 400, body: "{}" },
      { status: 401, body: "not json" },
    ]) {
      const { tenantId, configure } = await connectedTenant();
      configure({ refresh });
      await expect(getFicAccessToken(tenantId, deps(LATER)), JSON.stringify(refresh)).rejects.toBeInstanceOf(
        FicReauthorizationRequiredError,
      );
      expect((await row(tenantId)).status).toBe("reauthorization_required");
    }

    const { tenantId, configure } = await connectedTenant();
    const before = await row(tenantId);
    configure({ refresh: { status: 401, body: JSON.stringify({ error: "invalid_client" }) } });
    const error = await getFicAccessToken(tenantId, deps(LATER)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FicTokenRefreshFailedError);
    expect(error).toMatchObject({ retryable: false, httpStatus: 401, oauthError: "invalid_client" });
    expect(await row(tenantId)).toEqual(before);
  });

  it("the client credentials refused by FiC (invalid_client) leave the link untouched", async () => {
    const { tenantId } = await connectedTenant();
    const before = await row(tenantId);
    const wrong = { ...config, clientSecret: "not-the-secret" };
    await expect(getFicAccessToken(tenantId, deps(LATER, { config: wrong }))).rejects.toBeInstanceOf(FicTokenRefreshFailedError);
    expect(await row(tenantId)).toEqual(before);
  });
});

describe("getFicAccessToken: temporary errors", () => {
  it("5xx, 429, an invalid 200, a timeout or a network error: state and tokens unchanged, retryable FicTokenRefreshUnavailableError", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch;
    for (const [label, scenario, extra, reason] of [
      ["500", { refresh: { status: 500 } }, {}, "fic_server_error"],
      ["503", { refresh: { status: 503 } }, {}, "fic_server_error"],
      ["429", { refresh: { status: 429, body: "{}" } }, {}, "fic_rate_limited"],
      ["invalid 200", { refresh: { status: 200, body: "<html>" } }, {}, "fic_invalid_response"],
      ["timeout", { refreshDelayMs: 500 }, { timeoutMs: 50 }, "fic_timeout"],
      ["network error", {}, { fetch: down }, "fic_network_error"],
    ] as [string, FakeFicScenario, FicAccessTokenDeps, string][]) {
      const { tenantId, issued, configure } = await connectedTenant();
      configure(scenario);
      const before = await row(tenantId);
      const captured = logs();
      const error = await getFicAccessToken(tenantId, deps(LATER, { ...extra, log: captured.log })).catch((e: unknown) => e);
      expect(error, label).toBeInstanceOf(FicTokenRefreshUnavailableError);
      expect(error, label).toMatchObject({ retryable: true, reason });
      expect(await row(tenantId), label).toEqual(before);
      for (const text of [captured.text(), String(error), JSON.stringify(error)]) {
        expect(text, label).not.toContain(issued.refreshToken);
        expect(text, label).not.toContain(issued.accessToken);
      }
    }
  });

  it("after a temporary error the next call renews normally", async () => {
    const { tenantId, state, configure } = await connectedTenant();
    configure({ refresh: { status: 502 } });
    await expect(getFicAccessToken(tenantId, deps(LATER))).rejects.toBeInstanceOf(FicTokenRefreshUnavailableError);
    configure({});
    expect(await getFicAccessToken(tenantId, deps(LATER))).toBe(fake.issuedTokens(state)!.accessToken);
  });
});

describe("getFicAccessToken: renewal saved badly", () => {
  it("refresh succeeded on FiC but the save failed: error logged, reauthorization_required, FicReauthorizationRequiredError", async () => {
    const { tenantId, state, issued } = await connectedTenant();
    // A database failure on the UPDATE of the renewed tokens, for this tenant only.
    await testSql().unsafe(`
      CREATE OR REPLACE FUNCTION vistato_test_fail_token_save() RETURNS trigger AS $$
      BEGIN
        IF NEW.tenant_id = '${tenantId}' AND NEW.status = 'connected'
           AND NEW.access_token_enc IS DISTINCT FROM OLD.access_token_enc THEN
          RAISE EXCEPTION 'simulated failure while saving the renewed tokens';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await testSql().unsafe(
      `CREATE TRIGGER vistato_test_fail_token_save BEFORE UPDATE ON fic_connections
       FOR EACH ROW EXECUTE FUNCTION vistato_test_fail_token_save()`,
    );
    const captured = logs();
    let error: unknown;
    try {
      error = await getFicAccessToken(tenantId, deps(LATER, { log: captured.log })).catch((e: unknown) => e);
    } finally {
      await testSql().unsafe("DROP TRIGGER IF EXISTS vistato_test_fail_token_save ON fic_connections");
      await testSql().unsafe("DROP FUNCTION IF EXISTS vistato_test_fail_token_save()");
    }

    expect(error).toBeInstanceOf(FicReauthorizationRequiredError);
    expect(fake.tokenCalls(state).refresh).toBe(1);
    const after = await row(tenantId);
    expect(after).toMatchObject({
      status: "reauthorization_required",
      access_token_enc: null,
      refresh_token_enc: null,
      last_refresh_error: "save_failed",
    });
    expect(captured.entries).toContainEqual(expect.objectContaining({ level: "error", event: "fic_token_save_failed", tenantId }));
    const latest = fake.issuedTokens(state)!;
    for (const secret of [issued.accessToken, issued.refreshToken, latest.accessToken, latest.refreshToken]) {
      expect(captured.text()).not.toContain(secret);
    }
    // Why the link cannot be kept: FiC has already rotated the refresh token we still had.
    const reuse = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: issued.refreshToken,
      }),
    });
    expect(reuse.status).toBe(400);
  });

  it("does not drop a link renewed meanwhile by someone else (the tokens compared before dropping them)", async () => {
    const { tenantId } = await connectedTenant();
    const scope = forTenant(tenantId);
    const stale = await scope.ficConnection.readTokens();
    // Someone else renews it.
    await getFicAccessToken(tenantId, deps(LATER));
    const changed = await scope.ficConnection.requireReauthorizationIfUnchanged(
      { connectionId: stale!.connectionId, accessTokenEnc: stale!.accessTokenEnc!, refreshTokenEnc: stale!.refreshTokenEnc! },
      "save_failed",
      LATER,
    );
    expect(changed).toBe(false);
    expect((await row(tenantId)).status).toBe("connected");
  });
});

describe("getFicAccessToken: no usable link", () => {
  it("no link, or a link still waiting for the company: FicNotConnectedError without calling FiC", async () => {
    const empty = await makeTenant();
    await expect(getFicAccessToken(empty, deps(LATER))).rejects.toBeInstanceOf(FicNotConnectedError);

    const tenantId = await makeTenant();
    const owner = await makeUser(tenantId);
    const pending = await link(owner, { companies: [company(), company()] });
    expect(pending.outcome).toBe("pending_company_selection");
    await expect(getFicAccessToken(tenantId, deps(LATER))).rejects.toBeInstanceOf(FicNotConnectedError);
    expect(fake.tokenCalls(pending.state).refresh).toBe(0);
  });

  it("an invalid tenant id is refused before any query", async () => {
    await expect(getFicAccessToken("not-a-uuid")).rejects.toMatchObject({ name: "ValidationError" });
  });

  it("a refresh token that does not decrypt (other key): nothing changes, FicTokenUnreadableError, FiC not called", async () => {
    const { tenantId, state } = await connectedTenant();
    const before = await row(tenantId);
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    await expect(getFicAccessToken(tenantId, deps(LATER))).rejects.toBeInstanceOf(FicTokenUnreadableError);
    expect(fake.tokenCalls(state).refresh).toBe(0);
    expect(await row(tenantId)).toEqual(before);
  });

  it("a token copied to another tenant's row does not decrypt there (AAD = tenant)", async () => {
    const a = await connectedTenant();
    const b = await connectedTenant();
    const rowA = await row(a.tenantId);
    await testSql()`update fic_connections set access_token_enc = ${rowA.access_token_enc}, refresh_token_enc = ${rowA.refresh_token_enc}
      where tenant_id = ${b.tenantId}`;
    await expect(getFicAccessToken(b.tenantId, deps(T0))).rejects.toBeInstanceOf(FicTokenUnreadableError);
    expect(fake.tokenCalls(a.state).refresh).toBe(0);
  });
});

describe("unlink (DELETE /api/integrations/fic)", () => {
  it("OWNER: 200 not_connected with connect, the row with tokens and company deleted, both tokens revoked on FiC", async () => {
    const { tenantId, owner, state, issued } = await connectedTenant();
    const res = await deleteIntegration(req("/api/integrations/fic", owner.token, { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({
      status: "not_connected",
      companyId: null,
      companyName: null,
      connectedAt: null,
      connectedBy: null,
      companies: null,
      _links: {
        self: { href: "/api/integrations/fic", title: "Fatture in Cloud" },
        connect: { href: "/api/integrations/fic/connect", method: "POST", title: "Collega Fatture in Cloud" },
      },
    });
    expect(await row(tenantId)).toBeUndefined();
    expect(fake.revokedTokens(state)).toEqual(
      expect.arrayContaining([
        { token: issued.refreshToken, hint: "refresh_token" },
        { token: issued.accessToken, hint: "access_token" },
      ]),
    );
    expect(fake.isAccessTokenValid(issued.accessToken)).toBe(false);

    const again = await deleteIntegration(req("/api/integrations/fic", owner.token, { method: "DELETE" }));
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("not_connected");
  });

  it("ADMIN can unlink; USER 403 forbidden, other Origin 403 forbidden_origin, no module 403 module_not_active, no session 401: nothing deleted", async () => {
    const { tenantId, owner } = await connectedTenant();
    const user = await makeUser(tenantId, "USER");
    const admin = await makeUser(tenantId, "ADMIN");
    const before = await row(tenantId);

    const forbidden = await deleteIntegration(req("/api/integrations/fic", user.token, { method: "DELETE" }));
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error).toBe("forbidden");
    const foreign = await deleteIntegration(
      req("/api/integrations/fic", owner.token, { method: "DELETE", headers: { Origin: "https://evil.example" } }),
    );
    expect(foreign.status).toBe(403);
    expect((await foreign.json()).error).toBe("forbidden_origin");
    const anonymous = await deleteIntegration(req("/api/integrations/fic", undefined, { method: "DELETE" }));
    expect(anonymous.status).toBe(401);
    expect(await row(tenantId)).toEqual(before);

    await forTenant(tenantId, testDb()).modules.cancel("fic_iban_alert");
    const noModule = await deleteIntegration(req("/api/integrations/fic", owner.token, { method: "DELETE" }));
    expect(noModule.status).toBe(403);
    expect((await noModule.json()).error).toBe("module_not_active");
    expect(await row(tenantId)).toEqual(before);

    await forTenant(tenantId, testDb()).modules.activate("fic_iban_alert", { activatedAt: PAST });
    expect((await deleteIntegration(req("/api/integrations/fic", admin.token, { method: "DELETE" }))).status).toBe(200);
    expect(await row(tenantId)).toBeUndefined();
  });

  it("a tenant without link gets 409 not_connected", async () => {
    const owner = await makeUser(await makeTenant());
    const res = await deleteIntegration(req("/api/integrations/fic", owner.token, { method: "DELETE" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("not_connected");
  });

  it("works on a link waiting for the choice of the company and on one to authorize again", async () => {
    const tenantId = await makeTenant();
    const owner = await makeUser(tenantId);
    const pending = await link(owner, { companies: [company(), company()] });
    expect(pending.outcome).toBe("pending_company_selection");
    const resource = await (await getIntegration(req("/api/integrations/fic", owner.token))).json();
    expect(resource._links.disconnect).toMatchObject({ href: "/api/integrations/fic", method: "DELETE" });
    expect((await deleteIntegration(req("/api/integrations/fic", owner.token, { method: "DELETE" }))).status).toBe(200);
    expect(await row(tenantId)).toBeUndefined();
    expect(fake.tokenCalls(pending.state).revoke).toBe(2);

    const reauth = await connectedTenant();
    reauth.configure({ refresh: "invalid_grant" });
    await expect(getFicAccessToken(reauth.tenantId, deps(LATER))).rejects.toBeInstanceOf(FicReauthorizationRequiredError);
    const res = await deleteIntegration(req("/api/integrations/fic", reauth.owner.token, { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("not_connected");
    expect(await row(reauth.tenantId)).toBeUndefined();
    // No token left to revoke.
    expect(fake.tokenCalls(reauth.state).revoke).toBe(0);
  });

  it("a failed revocation or no revocation endpoint does not block the unlink (logged, never a token)", async () => {
    const failing = await connectedTenant({ revokeResponse: { status: 500 } });
    const captured = logs();
    expect(await disconnectFic(failing.owner, { log: captured.log })).toEqual({ outcome: "disconnected", revocation: "failed" });
    expect(await row(failing.tenantId)).toBeUndefined();
    expect(captured.entries).toContainEqual(expect.objectContaining({ event: "fic_revocation_failed", httpStatus: 500 }));
    expect(captured.entries).toContainEqual(
      expect.objectContaining({ event: "fic_disconnected", tenantId: failing.tenantId, userId: failing.owner.user.id }),
    );
    for (const secret of [failing.issued.accessToken, failing.issued.refreshToken]) expect(captured.text()).not.toContain(secret);

    const unreachable = await connectedTenant();
    const offline = { ...config, revokeUrl: "http://127.0.0.1:9/oauth/revoke" };
    expect(await disconnectFic(unreachable.owner, { config: offline, log: () => {} })).toEqual({
      outcome: "disconnected",
      revocation: "failed",
    });

    const noEndpoint = await connectedTenant();
    vi.stubEnv("FIC_OAUTH_REVOKE_URL", "");
    const res = await deleteIntegration(req("/api/integrations/fic", noEndpoint.owner.token, { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(fake.tokenCalls(noEndpoint.state).revoke).toBe(0);
    expect(await row(noEndpoint.tenantId)).toBeUndefined();
  });

  it("during a refresh in progress: the unlink waits for it, then deletes and revokes the renewed tokens", async () => {
    const { tenantId, owner, state, issued, configure } = await connectedTenant();
    configure({ refreshDelayMs: 500 });
    const renewal = getFicAccessToken(tenantId, deps(LATER));
    await until(() => fake.tokenCalls(state).refresh === 1);

    const res = await deleteIntegration(req("/api/integrations/fic", owner.token, { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("not_connected");
    const renewed = fake.issuedTokens(state)!;
    expect(await renewal).toBe(renewed.accessToken);
    expect(await row(tenantId)).toBeUndefined();
    // The tokens revoked are the renewed ones, not the stale ones.
    const revoked = fake.revokedTokens(state).map((r) => r.token);
    expect(revoked).toEqual(expect.arrayContaining([renewed.accessToken, renewed.refreshToken]));
    expect(revoked).not.toContain(issued.refreshToken);
    await expect(getFicAccessToken(tenantId, deps(LATER))).rejects.toBeInstanceOf(FicNotConnectedError);
  });

  it("an unlink that holds the row first: the renewal waiting for the lock finds no link and FiC is not called", async () => {
    const { tenantId, state } = await connectedTenant();
    const observer = postgres(requireTestDatabaseUrl(), { max: 1, onnotice: () => {} });
    const holder = postgres(requireTestDatabaseUrl(), { max: 1, onnotice: () => {} });
    try {
      let renewal: Promise<unknown> | undefined;
      await holder.begin(async (tx) => {
        // Same lock an unlink in progress holds on the row.
        await tx`select id from fic_connections where tenant_id = ${tenantId} for update`;
        renewal = getFicAccessToken(tenantId, deps(LATER)).catch((e: unknown) => e);
        await until(async () => {
          const [{ waiting }] = await observer`
            select count(*)::int as waiting from pg_stat_activity
            where wait_event_type = 'Lock' and query ilike '%fic_connections%for update%'`;
          return waiting > 0;
        });
        await tx`delete from fic_connections where tenant_id = ${tenantId}`;
      });
      expect(await renewal).toBeInstanceOf(FicNotConnectedError);
      expect(fake.tokenCalls(state).refresh).toBe(0);
    } finally {
      await Promise.all([observer.end(), holder.end()]);
    }
  });
});

describe("tenant isolation and relinking", () => {
  it("tenant A's renewal, refusal and unlink leave tenant B's link and tokens unchanged", async () => {
    const a = await connectedTenant();
    const b = await connectedTenant();
    const rowB = await row(b.tenantId);

    await getFicAccessToken(a.tenantId, deps(LATER));
    a.configure({ refresh: "invalid_grant" });
    await expect(getFicAccessToken(a.tenantId, deps(at(4 * EXPIRES_IN * 1000)))).rejects.toBeInstanceOf(
      FicReauthorizationRequiredError,
    );
    expect(await row(b.tenantId)).toEqual(rowB);

    const res = await deleteIntegration(req("/api/integrations/fic", a.owner.token, { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(await row(b.tenantId)).toEqual(rowB);
    expect(fake.tokenCalls(b.state)).toEqual({ refresh: 0, revoke: 0 });
    expect(await getFicAccessToken(b.tenantId, deps(T0))).toBe(b.issued.accessToken);
    const bodyB = await (await getIntegration(req("/api/integrations/fic", b.owner.token))).json();
    expect(bodyB.status).toBe("connected");
  });

  it("after the unlink another tenant can link the same company (the unique constraint no longer blocks)", async () => {
    const shared = company();
    const a = await connectedTenant({ companies: [shared] });
    const ownerB = await makeUser(await makeTenant());
    expect((await link(ownerB, { companies: [shared] })).outcome).toBe("company_already_linked");

    expect((await deleteIntegration(req("/api/integrations/fic", a.owner.token, { method: "DELETE" }))).status).toBe(200);
    expect((await link(ownerB, { companies: [shared] })).outcome).toBe("connected");
    const rows = await testSql()`select tenant_id, fic_company_id from fic_connections`;
    expect(rows.map((r) => [r.tenant_id, Number(r.fic_company_id)])).toEqual([[ownerB.scope.tenantId, shared.id]]);
  });

  it("reauthorization_required: connect is allowed again and the new link replaces the old row", async () => {
    const { tenantId, owner, companies, configure } = await connectedTenant();
    configure({ refresh: "invalid_grant" });
    await expect(getFicAccessToken(tenantId, deps(LATER))).rejects.toBeInstanceOf(FicReauthorizationRequiredError);

    const connect = await postConnect(req("/api/integrations/fic/connect", owner.token, { method: "POST" }));
    expect(connect.status).toBe(200);
    const relinked = await link(owner, { companies }, LATER);
    expect(relinked.outcome).toBe("connected");
    const rows = await testSql()`select * from fic_connections where tenant_id = ${tenantId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "connected", last_refresh_error: null });
    expect(await getFicAccessToken(tenantId, deps(LATER))).toBe(relinked.issued.accessToken);
  });

  it("relinking to a company of another tenant fails and keeps the reauthorization_required row as it was", async () => {
    const other = await connectedTenant();
    const { tenantId, owner, configure } = await connectedTenant();
    configure({ refresh: "invalid_grant" });
    await expect(getFicAccessToken(tenantId, deps(LATER))).rejects.toBeInstanceOf(FicReauthorizationRequiredError);
    const before = await row(tenantId);
    expect((await link(owner, { companies: other.companies }, LATER)).outcome).toBe("company_already_linked");
    expect(await row(tenantId)).toEqual(before);
  });
});

describe("schema of fic_connections after #59", () => {
  it("refuses tokens in reauthorization_required and missing tokens in the other states", async () => {
    const { tenantId } = await connectedTenant();
    const attempts = [
      testSql()`update fic_connections set access_token_enc = null where tenant_id = ${tenantId}`,
      testSql()`update fic_connections set status = 'reauthorization_required', last_refresh_error = 'refresh_rejected',
        last_refresh_error_at = now() where tenant_id = ${tenantId}`,
      testSql()`update fic_connections set last_refresh_error = 'other', last_refresh_error_at = now() where tenant_id = ${tenantId}`,
      testSql()`update fic_connections set last_refresh_error = 'save_failed' where tenant_id = ${tenantId}`,
    ];
    for (const attempt of attempts) await expect(attempt).rejects.toMatchObject({ code: "23514" });
  });
});

describe("getFicAccessToken: renewals do not take the database pool (review of #77)", () => {
  it("10 tenants renewing while FiC is slow: an unrelated query on the pool does not wait for them", async () => {
    const tenants: Awaited<ReturnType<typeof connectedTenant>>[] = [];
    for (let i = 0; i < 10; i += 1) tenants.push(await connectedTenant());
    for (const tenant of tenants) tenant.configure({ refreshDelayMs: 1000 });
    const provider = createFicAccessTokenProvider();

    const renewals = tenants.map((tenant) => provider(tenant.tenantId, deps(LATER)));
    const calls = () => tenants.reduce((sum, tenant) => sum + fake.tokenCalls(tenant.state).refresh, 0);
    await until(() => calls() >= FIC_MAX_CONCURRENT_RENEWALS);

    const started = Date.now();
    await getSql()`select 1`;
    expect(Date.now() - started).toBeLessThan(500);
    // At most the provider's slots are in use, each one waiting on FiC.
    expect(calls()).toBe(FIC_MAX_CONCURRENT_RENEWALS);

    const tokens = await Promise.all(renewals);
    tenants.forEach((tenant, i) => expect(tokens[i]).toBe(fake.issuedTokens(tenant.state)!.accessToken));
    expect(calls()).toBe(10);
  }, 30_000);

  it("a renewal that waits too long for a slot fails retryable (lock_timeout) and changes nothing", async () => {
    const a = await connectedTenant();
    const b = await connectedTenant();
    a.configure({ refreshDelayMs: 500 });
    const before = await row(b.tenantId);
    const provider = createFicAccessTokenProvider({ maxConcurrentRenewals: 1, slotWaitMs: 50 });
    const first = provider(a.tenantId, deps(LATER));
    await until(() => fake.tokenCalls(a.state).refresh === 1);
    const error = await provider(b.tenantId, deps(LATER)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FicTokenRefreshUnavailableError);
    expect(error).toMatchObject({ retryable: true, reason: "lock_timeout" });
    expect(fake.tokenCalls(b.state).refresh).toBe(0);
    expect(await row(b.tenantId)).toEqual(before);
    expect(await first).toBe(fake.issuedTokens(a.state)!.accessToken);
  });

  it("after repeated temporary errors FiC is not asked again for a while: same retryable error, nothing changes; then it renews", async () => {
    const { tenantId, state, configure } = await connectedTenant();
    const other = await connectedTenant();
    other.configure({ refresh: { status: 503 } });
    configure({ refresh: { status: 503 } });
    const provider = createFicAccessTokenProvider();
    const before = await row(tenantId);

    for (let i = 0; i < FIC_RENEWAL_FAILURE_THRESHOLD; i += 1) {
      await expect(provider(tenantId, deps(LATER))).rejects.toBeInstanceOf(FicTokenRefreshUnavailableError);
    }
    expect(fake.tokenCalls(state).refresh).toBe(FIC_RENEWAL_FAILURE_THRESHOLD);

    configure({});
    const almost = new Date(LATER.getTime() + FIC_RENEWAL_BACKOFF_MS - 1);
    const remembered = await provider(tenantId, deps(almost)).catch((e: unknown) => e);
    expect(remembered).toBeInstanceOf(FicTokenRefreshUnavailableError);
    expect(remembered).toMatchObject({ retryable: true, reason: "fic_server_error", httpStatus: 503 });
    expect(fake.tokenCalls(state).refresh).toBe(FIC_RENEWAL_FAILURE_THRESHOLD);
    expect(await row(tenantId)).toEqual(before);

    // Another tenant is not affected by this tenant's memory.
    await expect(provider(other.tenantId, deps(LATER))).rejects.toBeInstanceOf(FicTokenRefreshUnavailableError);
    expect(fake.tokenCalls(other.state).refresh).toBe(1);

    // Once the backoff is over, one call asks FiC again and renews.
    const token = await provider(tenantId, deps(new Date(LATER.getTime() + FIC_RENEWAL_BACKOFF_MS)));
    expect(token).toBe(fake.issuedTokens(state)!.accessToken);
    expect(fake.tokenCalls(state).refresh).toBe(FIC_RENEWAL_FAILURE_THRESHOLD + 1);
  });
});

describe("getFicAccessToken: notes of the review of #77", () => {
  it("expires_in within the margin: 10 concurrent callers (10 providers) still cause one refresh only", async () => {
    const { tenantId, state, configure } = await connectedTenant();
    configure({ refreshDelayMs: 300, expiresIn: 30 });
    const providers = Array.from({ length: 10 }, () => createFicAccessTokenProvider());
    const tokens = await Promise.all(providers.map((provider) => provider(tenantId, deps(LATER))));
    expect(fake.tokenCalls(state).refresh).toBe(1);
    expect(new Set(tokens)).toEqual(new Set([fake.issuedTokens(state)!.accessToken]));
  });

  it("forceRefresh renews a token that is still valid (e.g. after a 401 from FiC)", async () => {
    const { tenantId, state, issued } = await connectedTenant();
    const token = await getFicAccessToken(tenantId, deps(T0, { forceRefresh: true }));
    expect(token).not.toBe(issued.accessToken);
    expect(token).toBe(fake.issuedTokens(state)!.accessToken);
    expect(fake.tokenCalls(state).refresh).toBe(1);
    expect(decryptAs(tenantId, (await row(tenantId)).access_token_enc, "fic_access_token")).toBe(token);
    // Without the option the renewed token is used as it is.
    expect(await getFicAccessToken(tenantId, deps(T0))).toBe(token);
    expect(fake.tokenCalls(state).refresh).toBe(1);
  });

  it("save failed and the link deleted before it is dropped: FicNotConnectedError, not reauthorization", async () => {
    const { tenantId, state, configure } = await connectedTenant();
    configure({ refreshDelayMs: 500 });
    await testSql().unsafe(`
      CREATE OR REPLACE FUNCTION vistato_test_fail_token_save() RETURNS trigger AS $$
      BEGIN
        IF NEW.tenant_id = '${tenantId}' AND NEW.status = 'connected'
           AND NEW.access_token_enc IS DISTINCT FROM OLD.access_token_enc THEN
          RAISE EXCEPTION 'simulated failure while saving the renewed tokens';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await testSql().unsafe(
      `CREATE TRIGGER vistato_test_fail_token_save BEFORE UPDATE ON fic_connections
       FOR EACH ROW EXECUTE FUNCTION vistato_test_fail_token_save()`,
    );
    const observer = postgres(requireTestDatabaseUrl(), { max: 1, onnotice: () => {} });
    const unlinker = postgres(requireTestDatabaseUrl(), { max: 1, onnotice: () => {} });
    try {
      const renewal = getFicAccessToken(tenantId, deps(LATER)).catch((e: unknown) => e);
      await until(() => fake.tokenCalls(state).refresh === 1);
      // An unlink queued behind the renewal's lock: it deletes the row right after the failed save.
      const unlink = unlinker.begin(async (tx) => {
        await tx`select id from fic_connections where tenant_id = ${tenantId} for update`;
        await tx`delete from fic_connections where tenant_id = ${tenantId}`;
      });
      await until(async () => {
        const [{ waiting }] = await observer`
          select count(*)::int as waiting from pg_stat_activity
          where wait_event_type = 'Lock' and query ilike '%fic_connections%for update%'`;
        return waiting > 0;
      });
      const error = await renewal;
      await unlink;
      expect(error).toBeInstanceOf(FicNotConnectedError);
      expect(await row(tenantId)).toBeUndefined();
    } finally {
      await testSql().unsafe("DROP TRIGGER IF EXISTS vistato_test_fail_token_save ON fic_connections");
      await testSql().unsafe("DROP FUNCTION IF EXISTS vistato_test_fail_token_save()");
      await Promise.all([observer.end(), unlinker.end()]);
    }
  });
});
