import { createHash, randomBytes, randomInt } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A fake Fatture in Cloud for e2e and integration tests: OAuth2 authorize (redirects at once,
 * no login page), token exchange with PKCE S256 check, and `GET /user/companies`.
 *
 * Tests run in parallel against one fake, so the behaviour is configured per authorization
 * request, keyed by its `state` (the value Vistato puts in the authorization URL), through
 * the control endpoints below (see `./control.ts`). A `state` without a scenario gets the
 * default: approve, valid tokens, one company with a random id.
 *
 * Control API (JSON):
 * - `PUT /__fake/scenarios/<state>`  body {@link FakeFicScenario}
 * - `GET /__fake/calls/<state>`      → {@link FakeFicCalls} received for that authorization
 *
 * Later tickets (refresh, received documents, webhooks) extend the scenario and the routes.
 */

export interface FakeFicCompany {
  id: number;
  name: string;
}

export interface FakeFicResponse {
  status: number;
  /** Raw body (default: a JSON error). */
  body?: string;
  contentType?: string;
}

export interface FakeFicScenario {
  /** `/oauth/authorize`: approve (default), the user refuses (`deny` = `access_denied`), or another OAuth error. */
  authorize?: "approve" | "deny" | { error: string };
  /** `/oauth/token` after a valid exchange: real tokens (default) or a canned response. */
  token?: "ok" | FakeFicResponse;
  /** Companies of `/user/companies` (default: one company with a random id). */
  companies?: FakeFicCompany[];
  /** A canned response of `/user/companies` instead of the companies. */
  companiesResponse?: FakeFicResponse;
}

export interface FakeFicCalls {
  authorize: number;
  token: number;
  companies: number;
}

export interface FakeFicOptions {
  /** 0 = a random free port (integration tests). */
  port?: number;
  host?: string;
  clientId?: string;
  clientSecret?: string;
}

export interface FakeFic {
  /** Base URL, e.g. `http://127.0.0.1:3190`. */
  url: string;
  setScenario(state: string, scenario: FakeFicScenario): void;
  calls(state: string): FakeFicCalls;
  /** The tokens issued for the authorization request with this `state` (in-process use only). */
  issuedTokens(state: string): { accessToken: string; refreshToken: string } | undefined;
  /** Every request received (method, path), for assertions on what was (not) called. */
  readonly requests: { method: string; path: string }[];
  close(): Promise<void>;
}

export const FAKE_FIC_CLIENT_ID = "vistato-e2e-client";
export const FAKE_FIC_CLIENT_SECRET = "vistato-e2e-secret-not-a-secret";

interface IssuedCode {
  state: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  used: boolean;
}

const MAX_BODY = 64 * 1024;

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function canned(res: ServerResponse, response: FakeFicResponse) {
  res.writeHead(response.status, { "Content-Type": response.contentType ?? "application/json" });
  res.end(response.body ?? JSON.stringify({ error: "server_error", error_description: "fake failure" }));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseForm(req: IncomingMessage, body: string): Record<string, unknown> {
  const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (type === "application/x-www-form-urlencoded") return Object.fromEntries(new URLSearchParams(body));
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const s256 = (verifier: string) => createHash("sha256").update(verifier, "ascii").digest("base64url");

export async function startFakeFic(options: FakeFicOptions = {}): Promise<FakeFic> {
  const clientId = options.clientId ?? FAKE_FIC_CLIENT_ID;
  const clientSecret = options.clientSecret ?? FAKE_FIC_CLIENT_SECRET;
  const scenarios = new Map<string, FakeFicScenario>();
  const calls = new Map<string, FakeFicCalls>();
  const codes = new Map<string, IssuedCode>();
  const tokens = new Map<string, string>(); // access token -> state
  const issuedTokens = new Map<string, { accessToken: string; refreshToken: string }>(); // state -> tokens
  const requests: { method: string; path: string }[] = [];

  const scenarioOf = (state: string): FakeFicScenario => {
    let scenario = scenarios.get(state);
    if (!scenario) {
      scenario = { companies: [{ id: randomInt(1, 2 ** 31), name: "Azienda di prova S.r.l." }] };
      scenarios.set(state, scenario);
    }
    return scenario;
  };
  const count = (state: string, what: keyof FakeFicCalls) => {
    const entry = calls.get(state) ?? { authorize: 0, token: 0, companies: 0 };
    entry[what] += 1;
    calls.set(state, entry);
  };

  function authorize(url: URL, res: ServerResponse) {
    const p = url.searchParams;
    const state = p.get("state") ?? "";
    const redirectUri = p.get("redirect_uri") ?? "";
    if (state) count(state, "authorize");
    if (
      p.get("response_type") !== "code" ||
      p.get("client_id") !== clientId ||
      !/^https?:\/\//.test(redirectUri) ||
      !p.get("scope") ||
      !state ||
      p.get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(p.get("code_challenge") ?? "")
    ) {
      return json(res, 400, { error: "invalid_request", error_description: "fake: bad authorization request" });
    }
    const scenario = scenarioOf(state);
    const back = new URL(redirectUri);
    if (scenario.authorize === "deny" || typeof scenario.authorize === "object") {
      back.searchParams.set("error", scenario.authorize === "deny" ? "access_denied" : scenario.authorize.error);
      back.searchParams.set("error_description", "fake: the user did not authorize");
    } else {
      const code = `c-${randomBytes(24).toString("base64url")}`;
      codes.set(code, { state, clientId, redirectUri, challenge: p.get("code_challenge")!, used: false });
      back.searchParams.set("code", code);
    }
    back.searchParams.set("state", state);
    res.writeHead(302, { Location: back.href, "Cache-Control": "no-store" });
    res.end();
  }

  async function token(req: IncomingMessage, res: ServerResponse) {
    const form = parseForm(req, await readBody(req));
    const issued = typeof form.code === "string" ? codes.get(form.code) : undefined;
    if (issued) count(issued.state, "token");
    const invalidGrant = () => json(res, 400, { error: "invalid_grant", error_description: "fake: invalid grant" });
    if (form.grant_type !== "authorization_code") return json(res, 400, { error: "unsupported_grant_type" });
    if (form.client_id !== clientId || form.client_secret !== clientSecret) {
      return json(res, 401, { error: "invalid_client" });
    }
    if (!issued || issued.used || form.redirect_uri !== issued.redirectUri) return invalidGrant();
    issued.used = true;
    if (typeof form.code_verifier !== "string" || s256(form.code_verifier) !== issued.challenge) return invalidGrant();
    const scenario = scenarioOf(issued.state);
    if (scenario.token && scenario.token !== "ok") return canned(res, scenario.token);
    const accessToken = `a/fake-${randomBytes(24).toString("base64url")}`;
    const refreshToken = `r/fake-${randomBytes(24).toString("base64url")}`;
    tokens.set(accessToken, issued.state);
    issuedTokens.set(issued.state, { accessToken, refreshToken });
    json(res, 200, { token_type: "bearer", access_token: accessToken, refresh_token: refreshToken, expires_in: 86400 });
  }

  function companies(req: IncomingMessage, res: ServerResponse) {
    const auth = req.headers.authorization ?? "";
    const state = auth.startsWith("Bearer ") ? tokens.get(auth.slice("Bearer ".length)) : undefined;
    if (!state) return json(res, 401, { error: { message: "fake: unauthorized" } });
    count(state, "companies");
    const scenario = scenarioOf(state);
    if (scenario.companiesResponse) return canned(res, scenario.companiesResponse);
    json(res, 200, {
      data: {
        companies: (scenario.companies ?? []).map(({ id, name }) => ({
          id,
          name,
          tax_code: "",
          type: "company",
          access_token: "never-used-by-vistato",
          connection_id: 1,
          controlled_companies: [],
        })),
      },
    });
  }

  async function control(req: IncomingMessage, res: ServerResponse, path: string) {
    const scenarioMatch = /^\/__fake\/scenarios\/([^/]+)$/.exec(path);
    if (scenarioMatch && req.method === "PUT") {
      scenarios.set(decodeURIComponent(scenarioMatch[1]), JSON.parse(await readBody(req)) as FakeFicScenario);
      return json(res, 200, { ok: true });
    }
    const callsMatch = /^\/__fake\/calls\/([^/]+)$/.exec(path);
    if (callsMatch && req.method === "GET") {
      return json(res, 200, calls.get(decodeURIComponent(callsMatch[1])) ?? { authorize: 0, token: 0, companies: 0 });
    }
    json(res, 404, { error: "fake: unknown control endpoint" });
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake-fic.invalid");
    const path = url.pathname;
    if (!path.startsWith("/__fake/")) requests.push({ method: req.method ?? "", path });
    const handle = async () => {
      if (path.startsWith("/__fake/")) return control(req, res, path);
      if (req.method === "GET" && path === "/oauth/authorize") return authorize(url, res);
      if (req.method === "POST" && path === "/oauth/token") return token(req, res);
      if (req.method === "GET" && path === "/user/companies") return companies(req, res);
      json(res, 404, { error: { message: `fake: no route for ${req.method} ${path}` } });
    };
    handle().catch(() => {
      if (!res.headersSent) json(res, 500, { error: "fake: internal error" });
      else res.end();
    });
  });

  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://${host}:${port}`,
    setScenario: (state, scenario) => void scenarios.set(state, scenario),
    calls: (state) => calls.get(state) ?? { authorize: 0, token: 0, companies: 0 },
    issuedTokens: (state) => issuedTokens.get(state),
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
