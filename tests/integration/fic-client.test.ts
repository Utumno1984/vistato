import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createFicClient,
  FIC_DEFAULT_BASE_URL,
  FIC_DEFAULT_MAX_ATTEMPTS,
  FIC_DEFAULT_TIMEOUT_MS,
  FIC_MAX_RETRY_AFTER_MS,
  type FicClientOptions,
  readFicConfig,
} from "@/lib/fic/client";
import {
  FicConfigError,
  FicError,
  FicForbiddenError,
  FicHttpError,
  FicInvalidArgumentError,
  FicInvalidResponseError,
  FicNetworkError,
  FicNotFoundError,
  FicRateLimitedError,
  FicServerError,
  FicTimeoutError,
  FicUnauthorizedError,
} from "@/lib/fic/errors";
import { SlidingWindowRateLimiter } from "@/lib/fic/rate-limiter";

import { FakeClock } from "../helpers/fake-clock";

const TOKEN = "a/fic-test-token.SECRET-0123456789abcdef";

interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}
type Handler = (req: IncomingMessage, res: ServerResponse, recorded: Recorded) => void;

let server: Server;
let baseUrl: string;
let handler: Handler;
const requests: Recorded[] = [];

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const companiesBody = (companies: unknown[]) => ({ data: { companies } });
const infoBody = (data: Record<string, unknown>) => ({ data });

/** Answers each request with the next entry; the last one repeats. */
function sequence(...steps: Handler[]): Handler {
  let i = 0;
  return (req, res, recorded) => steps[Math.min(i++, steps.length - 1)](req, res, recorded);
}
const status =
  (code: number, headers: Record<string, string> = {}, body: unknown = { error: { message: "x" } }): Handler =>
  (_req, res) =>
    json(res, code, body, headers);
const ok =
  (body: unknown): Handler =>
  (_req, res) =>
    json(res, 200, body);

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      const recorded = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      requests.push(recorded);
      handler(req, res, recorded);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let sleeps: number[];

beforeEach(() => {
  requests.length = 0;
  sleeps = [];
  handler = status(404);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A client on the fake FiC: instant recorded sleeps, its own limiter, fixed jitter. */
function fic(options: FicClientOptions = {}) {
  return createFicClient({
    baseUrl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    rateLimiter: new SlidingWindowRateLimiter(),
    ...options,
  });
}

async function caught(promise: Promise<unknown>): Promise<FicError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FicError);
    return error as FicError;
  }
  throw new Error("expected the call to fail");
}

/** Every way an error can end up in a log. */
function renderings(error: FicError): string[] {
  return [String(error), error.message, error.stack ?? "", JSON.stringify(error), inspect(error, { depth: 5 })];
}

function expectNoSecret(error: FicError, token = TOKEN) {
  for (const text of renderings(error)) {
    expect(text).not.toContain(token);
    // An Authorization value echoed by FiC may appear only redacted.
    expect(text).not.toMatch(/Bearer\s+(?!\[REDACTED\])\S/);
  }
}

describe("FiC client: listCompanies", () => {
  it("returns the typed companies and sends Authorization: Bearer <token>", async () => {
    handler = ok(
      companiesBody([
        { id: 101, name: "Rossi S.r.l.", type: "company", access_info: { role: "master" }, controlled_companies: [] },
      ]),
    );
    const companies = await fic().listCompanies(TOKEN);
    expect(companies).toEqual([{ id: 101, name: "Rossi S.r.l." }]);
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("GET");
    expect(requests[0].url).toBe("/user/companies");
    expect(requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(requests[0].headers.accept).toBe("application/json");
  });

  it("returns an empty list when the user has no company", async () => {
    handler = ok(companiesBody([]));
    expect(await fic().listCompanies(TOKEN)).toEqual([]);
  });

  it("returns several companies in the order FiC sends them", async () => {
    handler = ok(
      companiesBody([
        { id: 3, name: "Gamma" },
        { id: 1, name: "Alfa", extra: true },
        { id: 2, name: "Beta" },
      ]),
    );
    expect(await fic().listCompanies(TOKEN)).toEqual([
      { id: 3, name: "Gamma" },
      { id: 1, name: "Alfa" },
      { id: 2, name: "Beta" },
    ]);
  });

  it("is not held by the per-company limiter (no company in the path)", async () => {
    handler = ok(companiesBody([]));
    const clock = new FakeClock();
    const rateLimiter = new SlidingWindowRateLimiter({ maxRequests: 1, windowMs: 1000, now: clock.now, sleep: clock.sleep });
    const client = fic({ rateLimiter });
    await Promise.all([client.listCompanies(TOKEN), client.listCompanies(TOKEN), client.listCompanies(TOKEN)]);
    expect(requests).toHaveLength(3);
    expect(clock.sleeps).toEqual([]);
  });
});

describe("FiC client: getCompanyInfo", () => {
  it("calls GET /c/{company_id}/company/info (not /c/{company_id}/info) and returns the validated data", async () => {
    handler = ok(infoBody({ company_id: 123, name: "Bianchi S.p.A.", email: "x@example.com", plan_info: {} }));
    const info = await fic().getCompanyInfo(TOKEN, 123);
    expect(info).toEqual({ companyId: 123, name: "Bianchi S.p.A." });
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual(["GET /c/123/company/info"]);
    expect(requests[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("refuses an answer about another company", async () => {
    handler = ok(infoBody({ company_id: 999, name: "Altra" }));
    await expect(fic().getCompanyInfo(TOKEN, 123)).rejects.toBeInstanceOf(FicInvalidResponseError);
  });

  it.each([
    ["0", 0],
    ["negative", -5],
    ["not an integer", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["unsafe integer", 2 ** 53],
    ["a string", "12" as unknown as number],
    ["a path", "1/../../user" as unknown as number],
  ])("refuses companyId %s before any request", async (_label, companyId) => {
    handler = ok(infoBody({ company_id: 1, name: "x" }));
    const error = await caught(fic().getCompanyInfo(TOKEN, companyId));
    expect(error).toBeInstanceOf(FicInvalidArgumentError);
    expect(requests).toHaveLength(0);
  });
});

describe("FiC client: base URL", () => {
  it.each([
    ["without a trailing slash", ""],
    ["with a trailing slash", "/"],
    ["with several trailing slashes", "//"],
  ])("builds the same request path %s", async (_label, suffix) => {
    handler = ok(companiesBody([]));
    await fic({ baseUrl: `${baseUrl}${suffix}` }).listCompanies(TOKEN);
    expect(requests[0].url).toBe("/user/companies");
  });

  it("keeps a path prefix of the base URL, with or without the trailing slash", async () => {
    handler = ok(infoBody({ company_id: 5, name: "x" }));
    await fic({ baseUrl: `${baseUrl}/fake-fic` }).getCompanyInfo(TOKEN, 5);
    await fic({ baseUrl: `${baseUrl}/fake-fic/` }).getCompanyInfo(TOKEN, 5);
    expect(requests.map((r) => r.url)).toEqual(["/fake-fic/c/5/company/info", "/fake-fic/c/5/company/info"]);
  });

  it.each([
    ["not a URL", "api-v2.fattureincloud.it"],
    ["ftp", "ftp://api.example.com"],
    ["javascript", "javascript:alert(1)"],
    ["file", "file:///etc/passwd"],
    ["credentials", "https://user:pass@api.example.com"],
    ["query", "https://api.example.com/?x=1"],
    ["fragment", "https://api.example.com/#x"],
  ])("refuses a base URL that is %s", (_label, url) => {
    expect(() => fic({ baseUrl: url })).toThrow(FicConfigError);
  });

  it("reads FIC_API_BASE_URL, defaulting to the real API", () => {
    expect(readFicConfig({}).baseUrl).toBe(FIC_DEFAULT_BASE_URL);
    expect(FIC_DEFAULT_BASE_URL).toBe("https://api-v2.fattureincloud.it");
    expect(readFicConfig({ FIC_API_BASE_URL: "" }).baseUrl).toBe(FIC_DEFAULT_BASE_URL);
    expect(readFicConfig({ FIC_API_BASE_URL: "http://localhost:4010/" }).baseUrl).toBe("http://localhost:4010");
    expect(() => readFicConfig({ FIC_API_BASE_URL: "ftp://x" })).toThrow(FicConfigError);
  });

  it("reads the rate limit from the environment and refuses invalid values", () => {
    expect(readFicConfig({})).toMatchObject({ rateLimitMaxRequests: 280, rateLimitWindowMs: 300_000 });
    expect(
      readFicConfig({ FIC_RATE_LIMIT_MAX_REQUESTS: "100", FIC_RATE_LIMIT_WINDOW_SECONDS: "60" }),
    ).toMatchObject({ rateLimitMaxRequests: 100, rateLimitWindowMs: 60_000 });
    for (const value of ["0", "-1", "1.5", "abc", "1e3"]) {
      expect(() => readFicConfig({ FIC_RATE_LIMIT_MAX_REQUESTS: value })).toThrow(FicConfigError);
      expect(() => readFicConfig({ FIC_RATE_LIMIT_WINDOW_SECONDS: value })).toThrow(FicConfigError);
    }
  });

  it("the exported listCompanies and getCompanyInfo use FIC_API_BASE_URL", async () => {
    vi.stubEnv("FIC_API_BASE_URL", `${baseUrl}/from-env/`);
    vi.resetModules();
    const { listCompanies, getCompanyInfo } = await import("@/lib/fic/client");
    handler = (req, res) =>
      req.url?.endsWith("/user/companies")
        ? json(res, 200, companiesBody([{ id: 8, name: "Env" }]))
        : json(res, 200, infoBody({ company_id: 8, name: "Env" }));
    expect(await listCompanies(TOKEN)).toEqual([{ id: 8, name: "Env" }]);
    expect(await getCompanyInfo(TOKEN, 8)).toEqual({ companyId: 8, name: "Env" });
    expect(requests.map((r) => r.url)).toEqual(["/from-env/user/companies", "/from-env/c/8/company/info"]);
  });
});

describe("FiC client: invalid 200 responses", () => {
  const raw =
    (body: string, contentType: string | null = "application/json"): Handler =>
    (_req, res) => {
      res.writeHead(200, contentType ? { "Content-Type": contentType } : {});
      res.end(body);
    };

  it.each<[string, Handler]>([
    ["a company without name", ok(companiesBody([{ id: 1, name: "Ok" }, { id: 2 }]))],
    ["a company without id", ok(companiesBody([{ name: "x" }]))],
    ["an id as a string", ok(companiesBody([{ id: "1", name: "x" }]))],
    ["id 0", ok(companiesBody([{ id: 0, name: "x" }]))],
    ["a negative id", ok(companiesBody([{ id: -1, name: "x" }]))],
    ["a decimal id", ok(companiesBody([{ id: 1.5, name: "x" }]))],
    ["an empty name", ok(companiesBody([{ id: 1, name: "" }]))],
    ["a blank name", ok(companiesBody([{ id: 1, name: "   " }]))],
    ["a name that is not a string", ok(companiesBody([{ id: 1, name: 42 }]))],
    ["companies not an array", ok({ data: { companies: { id: 1, name: "x" } } })],
    ["no data", ok({ companies: [] })],
    ["data null", ok({ data: null })],
    ["a JSON array", ok([])],
    ["invalid JSON", raw('{"data": {"companies": [')],
    ["an empty body", raw("")],
    ["a Content-Type that is not JSON", raw(JSON.stringify(companiesBody([])), "text/html")],
    ["no Content-Type", raw(JSON.stringify(companiesBody([])), null)],
    ["invalid UTF-8", (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(Buffer.from([0x7b, 0xff, 0x7d]));
    }],
  ])("throws FicInvalidResponseError on %s, without retrying", async (_label, answer) => {
    handler = answer;
    const error = await caught(fic().listCompanies(TOKEN));
    expect(error).toBeInstanceOf(FicInvalidResponseError);
    expect(error.status).toBe(200);
    expect(requests).toHaveLength(1);
  });

  it.each<[string, unknown]>([
    ["no company_id", infoBody({ name: "x" })],
    ["company_id as a string", infoBody({ company_id: "7", name: "x" })],
    ["no name", infoBody({ company_id: 7 })],
  ])("throws FicInvalidResponseError on company info with %s", async (_label, body) => {
    handler = ok(body);
    await expect(fic().getCompanyInfo(TOKEN, 7)).rejects.toBeInstanceOf(FicInvalidResponseError);
  });

  it("accepts a JSON Content-Type with parameters and +json types", async () => {
    handler = raw(JSON.stringify(companiesBody([])), "application/json; charset=utf-8");
    expect(await fic().listCompanies(TOKEN)).toEqual([]);
    handler = raw(JSON.stringify(companiesBody([])), "application/problem+json");
    expect(await fic().listCompanies(TOKEN)).toEqual([]);
  });

  it("refuses a body over 5 MB without buffering it all", async () => {
    handler = raw(`{"data":{"companies":[],"pad":"${"x".repeat(6 * 1024 * 1024)}"}}`);
    const error = await caught(fic().listCompanies(TOKEN));
    expect(error).toBeInstanceOf(FicInvalidResponseError);
    expect(error.message).toContain("larger than");
  });
});

describe("FiC client: 401, 403, 404 and other statuses", () => {
  it.each<[number, new (...args: never[]) => FicError]>([
    [401, FicUnauthorizedError],
    [403, FicForbiddenError],
    [404, FicNotFoundError],
    [400, FicHttpError],
    [409, FicHttpError],
  ])("answers %i with its typed error, without retrying", async (code, ErrorClass) => {
    handler = status(code);
    const error = await caught(fic().getCompanyInfo(TOKEN, 1));
    expect(error).toBeInstanceOf(ErrorClass);
    expect(error.status).toBe(code);
    expect(error.attempts).toBe(1);
    expect(requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("does not follow a redirect (the Authorization header must not travel elsewhere)", async () => {
    handler = (req, res) => {
      if (req.url === "/elsewhere") return json(res, 200, companiesBody([]));
      res.writeHead(302, { Location: "/elsewhere" });
      res.end();
    };
    const error = await caught(fic().listCompanies(TOKEN));
    expect(error).toBeInstanceOf(FicHttpError);
    expect(error.status).toBe(302);
    expect(requests.map((r) => r.url)).toEqual(["/user/companies"]);
  });
});

describe("FiC client: 429 and Retry-After", () => {
  it("waits the 2 seconds of Retry-After: 2 and retries", async () => {
    handler = sequence(status(429, { "Retry-After": "2" }), ok(infoBody({ company_id: 1, name: "x" })));
    expect(await fic().getCompanyInfo(TOKEN, 1)).toEqual({ companyId: 1, name: "x" });
    expect(sleeps).toEqual([2000]);
    expect(requests).toHaveLength(2);
  });

  it("throws FicRateLimitedError after the default 3 attempts", async () => {
    expect(FIC_DEFAULT_MAX_ATTEMPTS).toBe(3);
    handler = status(429, { "Retry-After": "2" });
    const error = await caught(fic().getCompanyInfo(TOKEN, 1));
    expect(error).toBeInstanceOf(FicRateLimitedError);
    expect(error).toMatchObject({ status: 429, attempts: 3, retryAfterMs: 2000 });
    expect(requests).toHaveLength(3);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it("honours a configured number of attempts", async () => {
    handler = status(429, { "Retry-After": "1" });
    await expect(fic({ maxAttempts: 5 }).getCompanyInfo(TOKEN, 1)).rejects.toBeInstanceOf(FicRateLimitedError);
    expect(requests).toHaveLength(5);
    await expect(fic({ maxAttempts: 1 }).listCompanies(TOKEN)).rejects.toBeInstanceOf(FicRateLimitedError);
    expect(requests).toHaveLength(6);
  });

  it("refuses an invalid number of attempts or timeout", () => {
    for (const maxAttempts of [0, -1, 1.5]) expect(() => fic({ maxAttempts })).toThrow(FicConfigError);
    for (const timeoutMs of [0, -1, Number.POSITIVE_INFINITY]) expect(() => fic({ timeoutMs })).toThrow(FicConfigError);
  });

  const now = Date.parse("2026-11-01T10:00:00Z");
  // With random() = 0.5 the first backoff is 500/2 + 0.5 * 500/2 = 375 ms.
  it.each<[string, string | null, number]>([
    ["absent: backoff", null, 375],
    ["not a number: backoff", "soon", 375],
    ["negative: backoff", "-5", 375],
    ["decimal: backoff", "1.5", 375],
    ["empty: backoff", "", 375],
    ["zero", "0", 0],
    ["an HTTP date 5 s ahead", "Sun, 01 Nov 2026 10:00:05 GMT", 5000],
    ["an HTTP date in the past: no wait", "Sun, 01 Nov 2026 09:00:00 GMT", 0],
    ["an HTTP date far ahead: capped at 60 s", "Mon, 02 Nov 2026 10:00:00 GMT", 60_000],
    ["an invalid HTTP date: backoff", "Sun, 99 Nov 2026 99:00:00 GMT", 375],
    ["huge: capped at 60 s", "86400", 60_000],
    ["beyond any integer: capped at 60 s", "9".repeat(400), 60_000],
  ])("Retry-After %s", async (_label, value, expectedWait) => {
    expect(FIC_MAX_RETRY_AFTER_MS).toBe(60_000);
    handler = sequence(status(429, value === null ? {} : { "Retry-After": value }), ok(companiesBody([])));
    await fic({ now: () => now }).listCompanies(TOKEN);
    expect(sleeps).toEqual([expectedWait]);
  });
});

describe("FiC client: 5xx and network errors", () => {
  it.each([500, 502, 503])("retries a GET on %i with growing backoff, then throws FicServerError", async (code) => {
    handler = status(code);
    const error = await caught(fic().getCompanyInfo(TOKEN, 1));
    expect(error).toBeInstanceOf(FicServerError);
    expect(error).toMatchObject({ status: code, attempts: 3 });
    expect(requests).toHaveLength(3);
    expect(sleeps).toEqual([375, 750]);
  });

  it("returns the data when a retry succeeds", async () => {
    handler = sequence(status(503), status(502), ok(companiesBody([{ id: 1, name: "x" }])));
    expect(await fic().listCompanies(TOKEN)).toEqual([{ id: 1, name: "x" }]);
    expect(requests).toHaveLength(3);
  });

  it("adds jitter within [exp/2, exp] on a doubling exponent", async () => {
    handler = status(500);
    await caught(fic({ maxAttempts: 5, random: () => 0 }).listCompanies(TOKEN));
    await caught(fic({ maxAttempts: 5, random: () => 0.999999 }).listCompanies(TOKEN));
    expect(sleeps).toEqual([250, 500, 1000, 2000, 500, 1000, 2000, 4000]);
  });

  it("retries a GET on a dropped connection, then throws FicNetworkError", async () => {
    handler = (req) => req.socket.destroy();
    const error = await caught(fic().listCompanies(TOKEN));
    expect(error).toBeInstanceOf(FicNetworkError);
    expect(error.attempts).toBe(3);
    expect(requests).toHaveLength(3);
    expect(sleeps).toEqual([375, 750]);
  });

  it("throws FicNetworkError when nothing listens on the port", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const error = await caught(fic({ baseUrl: `http://127.0.0.1:${port}` }).listCompanies(TOKEN));
    expect(error).toBeInstanceOf(FicNetworkError);
    expect(error).toMatchObject({ code: "ECONNREFUSED", attempts: 3 });
  });

  it("does not retry a POST on 5xx or on a network error, and sends its JSON body", async () => {
    const schema = z.object({ ok: z.boolean() });
    const client = fic();
    handler = status(500);
    const serverError = await caught(
      client.request({ method: "POST", path: "/c/1/subscriptions", token: TOKEN, companyId: 1, schema, body: { a: 1 } }),
    );
    expect(serverError).toBeInstanceOf(FicServerError);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: "POST", body: '{"a":1}' });
    expect(requests[0].headers["content-type"]).toBe("application/json");

    handler = (req) => req.socket.destroy();
    const networkError = await caught(client.request({ method: "POST", path: "/c/1/subscriptions", token: TOKEN, schema }));
    expect(networkError).toBeInstanceOf(FicNetworkError);
    expect(requests).toHaveLength(2);
    expect(sleeps).toEqual([]);
  });

  it("retries a POST on 429 (FiC did not process it)", async () => {
    handler = sequence(status(429, { "Retry-After": "1" }), ok({ ok: true }));
    const result = await fic().request({
      method: "POST",
      path: "/c/1/subscriptions",
      token: TOKEN,
      schema: z.object({ ok: z.boolean() }),
    });
    expect(result).toEqual({ ok: true });
    expect(requests).toHaveLength(2);
  });

  it.each(["//evil.example.com/x", "/c//x", "/", "/c/1/../../x", "/c/1/./x", "/x?token=1", "relative", "/x y"])(
    "refuses the request path %s before any request",
    async (path) => {
      handler = ok({});
      const error = await caught(fic().request({ method: "GET", path, token: TOKEN, schema: z.object({}) }));
      expect(error).toBeInstanceOf(FicInvalidArgumentError);
      expect(requests).toHaveLength(0);
    },
  );
});

describe("FiC client: timeout", () => {
  it("defaults to 15 seconds", () => {
    expect(FIC_DEFAULT_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts a request without an answer and throws FicTimeoutError", async () => {
    handler = () => undefined; // never answers
    const started = Date.now();
    const error = await caught(fic({ timeoutMs: 100, maxAttempts: 1 }).listCompanies(TOKEN));
    expect(error).toBeInstanceOf(FicTimeoutError);
    expect(error).toMatchObject({ timeoutMs: 100, attempts: 1 });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("aborts a response whose body never ends", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"data":');
    };
    const error = await caught(fic({ timeoutMs: 100, maxAttempts: 1 }).listCompanies(TOKEN));
    expect(error).toBeInstanceOf(FicTimeoutError);
  });

  it("retries a GET after a timeout, up to the max attempts", async () => {
    handler = () => undefined;
    const error = await caught(fic({ timeoutMs: 50, maxAttempts: 2 }).getCompanyInfo(TOKEN, 1));
    expect(error).toBeInstanceOf(FicTimeoutError);
    expect(error.attempts).toBe(2);
    expect(requests).toHaveLength(2);
  });
});

describe("FiC client: per-company limit", () => {
  it("queues the requests of a company over the limit without losing any, and does not slow another company", async () => {
    handler = (req, res) => {
      const id = Number(/^\/c\/(\d+)\//.exec(req.url ?? "")![1]);
      json(res, 200, infoBody({ company_id: id, name: `C${id}` }));
    };
    const clock = new FakeClock();
    const rateLimiter = new SlidingWindowRateLimiter({ maxRequests: 2, windowMs: 1000, now: clock.now, sleep: clock.sleep });
    const client = fic({ rateLimiter });
    const hits = (id: number) => requests.filter((r) => r.url === `/c/${id}/company/info`).length;

    const queued = Promise.all(Array.from({ length: 5 }, () => client.getCompanyInfo(TOKEN, 1)));
    await vi.waitFor(() => expect(hits(1)).toBe(2));
    expect(clock.sleeps).toEqual([1000]);

    // Company 2 is not held by company 1's queue.
    expect(await client.getCompanyInfo(TOKEN, 2)).toEqual({ companyId: 2, name: "C2" });
    expect(await client.getCompanyInfo(TOKEN, 2)).toEqual({ companyId: 2, name: "C2" });
    expect(hits(1)).toBe(2);

    await clock.advance(1000);
    await vi.waitFor(() => expect(hits(1)).toBe(4));
    await clock.advance(1000);
    const results = await queued;
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.companyId === 1)).toBe(true);
    expect(hits(1)).toBe(5);
  });

  it("counts every retry against the limit", async () => {
    handler = sequence(status(503), ok(infoBody({ company_id: 1, name: "x" })));
    const clock = new FakeClock();
    const rateLimiter = new SlidingWindowRateLimiter({ maxRequests: 1, windowMs: 1000, now: clock.now, sleep: clock.sleep });
    const pending = fic({ rateLimiter }).getCompanyInfo(TOKEN, 1);
    await vi.waitFor(() => expect(clock.pendingSleeps).toBe(1));
    expect(requests).toHaveLength(1);
    await clock.advance(1000);
    expect(await pending).toEqual({ companyId: 1, name: "x" });
    expect(requests).toHaveLength(2);
  });
});

describe("FiC client: no secrets in errors", () => {
  const echo: Handler = (req, res, recorded) =>
    json(res, req.url?.includes("/c/") ? 403 : 401, {
      error: { message: `token ${TOKEN} refused`, authorization: recorded.headers.authorization },
    });

  it("refuses a missing or malformed token before any request, without echoing it", async () => {
    handler = ok(companiesBody([]));
    for (const token of ["", "has space", "line\nbreak", "tab\there", "àccented", undefined as unknown as string]) {
      const error = await caught(fic().listCompanies(token));
      expect(error).toBeInstanceOf(FicInvalidArgumentError);
      if (token) expectNoSecret(error, token);
    }
    expect(requests).toHaveLength(0);
  });

  it("redacts the token and the Authorization value FiC echoes back (401, 403)", async () => {
    handler = echo;
    const unauthorized = await caught(fic().listCompanies(TOKEN));
    const forbidden = await caught(fic().getCompanyInfo(TOKEN, 1));
    for (const error of [unauthorized, forbidden]) {
      expectNoSecret(error);
      expect(error.bodyExcerpt).toContain("[REDACTED]");
    }
  });

  it("never leaks the token from invalid responses, 5xx, 429, timeouts and network errors", async () => {
    const errors: FicError[] = [];
    handler = ok({ data: { companies: [{ id: TOKEN, name: `Bearer ${TOKEN}` }] } });
    errors.push(await caught(fic().listCompanies(TOKEN)));
    handler = status(500, {}, { error: TOKEN });
    errors.push(await caught(fic().listCompanies(TOKEN)));
    handler = status(429, { "Retry-After": TOKEN }, { error: TOKEN });
    errors.push(await caught(fic().listCompanies(TOKEN)));
    handler = () => undefined;
    errors.push(await caught(fic({ timeoutMs: 50, maxAttempts: 1 }).listCompanies(TOKEN)));
    handler = (req) => req.socket.destroy();
    errors.push(await caught(fic({ maxAttempts: 1 }).listCompanies(TOKEN)));
    expect(errors.map((e) => e.constructor)).toEqual([
      FicInvalidResponseError,
      FicServerError,
      FicRateLimitedError,
      FicTimeoutError,
      FicNetworkError,
    ]);
    for (const error of errors) expectNoSecret(error);
  });

  it("truncates the FiC body in the error to 1 KB without splitting a character", async () => {
    handler = (_req, res) => {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("è".repeat(5000));
    };
    const error = await caught(fic().getCompanyInfo(TOKEN, 1));
    const bytes = Buffer.byteLength(error.bodyExcerpt ?? "", "utf8");
    expect(bytes).toBeLessThanOrEqual(1024);
    expect(bytes).toBeGreaterThan(1000);
    expect(error.bodyExcerpt).toMatch(/^è+$/);
    expect(JSON.stringify(error).length).toBeLessThan(2048);
  });

  it("redacts a token cut in half at the 1 KB limit", async () => {
    handler = status(500, {}, "x".repeat(1024 - TOKEN.length / 2) + TOKEN);
    const error = await caught(fic({ maxAttempts: 1 }).listCompanies(TOKEN));
    const half = TOKEN.slice(0, Math.floor(TOKEN.length / 3));
    expect(error.bodyExcerpt).not.toContain(half);
    expect(error.bodyExcerpt?.endsWith("[REDACTED]")).toBe(true);
    expect(Buffer.byteLength(error.bodyExcerpt ?? "", "utf8")).toBeLessThanOrEqual(1024);
  });

  it("turns control characters of the FiC body into spaces (one log line)", async () => {
    handler = status(404, {}, "line1\r\nline2\u0000\u001b[31m end");
    const error = await caught(fic().getCompanyInfo(TOKEN, 1));
    expect(error.bodyExcerpt).toBe("line1  line2  [31m end");
  });
});

describe("FiC client: token echoed in other encodings", () => {
  /** The part of the token after `a/`: no rendering may contain any piece of it. */
  const SECRET = TOKEN.slice(2);
  const ESCAPED = TOKEN.replaceAll("/", "\\/"); // PHP json_encode
  const ENCODED = encodeURIComponent(TOKEN); // a%2F...

  function expectNoSecretPart(error: FicError) {
    for (const text of renderings(error)) {
      expect(text).not.toContain(SECRET.slice(0, 12));
      expect(text).not.toContain(SECRET.slice(-12));
    }
  }

  /** Sends `body` verbatim (no JSON.stringify, which would not escape `/`). */
  const verbatim =
    (code: number, body: string): Handler =>
    (_req, res) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(body);
    };

  it("redacts a token echoed with an escaped slash (a\\/...) or URL-encoded (a%2F...)", async () => {
    expect(ENCODED).toContain("%2F");
    const errors: FicError[] = [];
    handler = verbatim(401, `{"error":{"message":"token ${ESCAPED} refused"}}`);
    errors.push(await caught(fic().listCompanies(TOKEN)));
    handler = verbatim(403, `{"error":{"url":"/oauth?access_token=${ENCODED}&x=1"}}`);
    errors.push(await caught(fic().getCompanyInfo(TOKEN, 1)));
    handler = verbatim(500, `{"lower":"${ENCODED.replace("%2F", "%2f")}"}`);
    errors.push(await caught(fic({ maxAttempts: 1 }).listCompanies(TOKEN)));
    handler = verbatim(429, `{"secret_only":"${SECRET}"}`);
    errors.push(await caught(fic({ maxAttempts: 1 }).listCompanies(TOKEN)));
    for (const error of errors) {
      expectNoSecretPart(error);
      expect(error.bodyExcerpt).toContain("[REDACTED]");
    }
  });

  it("redacts an escaped or URL-encoded token cut in half at the 1 KB limit", async () => {
    for (const form of [ESCAPED, ENCODED]) {
      handler = verbatim(500, "x".repeat(1024 - 14) + form);
      const error = await caught(fic({ maxAttempts: 1 }).listCompanies(TOKEN));
      expect(error.bodyExcerpt?.endsWith("[REDACTED]")).toBe(true);
      expect(error.bodyExcerpt).not.toContain(form.slice(0, 14));
      expect(Buffer.byteLength(error.bodyExcerpt ?? "", "utf8")).toBeLessThanOrEqual(1024);
    }
  });
});

describe("FiC client: request body", () => {
  const schema = z.object({ ok: z.boolean() });

  it("refuses a body on a GET before any request", async () => {
    handler = ok({ ok: true });
    const error = await caught(fic().request({ method: "GET", path: "/c/1/x", token: TOKEN, schema, body: { a: 1 } }));
    expect(error).toBeInstanceOf(FicInvalidArgumentError);
    expect(requests).toHaveLength(0);
  });

  it("refuses a body that is not serialisable to JSON, without requests or retries", async () => {
    handler = ok({ ok: true });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const body of [{ amount: BigInt(10) }, circular, () => 1]) {
      const error = await caught(fic().request({ method: "POST", path: "/c/1/x", token: TOKEN, schema, body }));
      expect(error).toBeInstanceOf(FicInvalidArgumentError);
      expect(error).not.toBeInstanceOf(FicNetworkError);
    }
    expect(requests).toHaveLength(0);
    expect(sleeps).toEqual([]);
  });

  it("does not turn a non-network failure into FicNetworkError nor retry it", async () => {
    const bug = new RangeError("bug inside the fetch implementation");
    let calls = 0;
    const client = fic({
      fetch: async () => {
        calls++;
        throw bug;
      },
    });
    await expect(client.listCompanies(TOKEN)).rejects.toBe(bug);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });
});

describe("FiC client: plain http only towards localhost", () => {
  it.each(["http://api-v2.fattureincloud.it", "http://10.0.0.5:8080", "http://fake-fic:4010", "http://127.0.0.2"])(
    "refuses the plain http base URL %s",
    (url) => {
      expect(() => fic({ baseUrl: url })).toThrow(FicConfigError);
      expect(() => readFicConfig({ FIC_API_BASE_URL: url })).toThrow(FicConfigError);
    },
  );

  it("accepts plain http on localhost, 127.0.0.1 and [::1], and https anywhere", () => {
    for (const url of ["http://localhost:4010", "http://127.0.0.1:4010/", "http://[::1]:4010", "https://fake-fic.example.com"]) {
      expect(() => fic({ baseUrl: url })).not.toThrow();
    }
  });
});
