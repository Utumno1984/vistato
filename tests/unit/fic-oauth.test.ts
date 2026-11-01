import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { FicConfigError, FicHttpError, FicInvalidArgumentError, FicInvalidResponseError, FicNetworkError, FicServerError, FicTimeoutError } from "@/lib/fic/errors";
import {
  buildAuthorizationUrl,
  createOAuthState,
  createPkcePair,
  exchangeAuthorizationCode,
  FIC_DEFAULT_OAUTH_AUTHORIZE_URL,
  FIC_DEFAULT_OAUTH_TOKEN_URL,
  FIC_OAUTH_SCOPE,
  FIC_OAUTH_SCOPES,
  FIC_OAUTH_STATE_PATTERN,
  type FicOAuthConfig,
  isPlausibleAuthorizationCode,
  pkceChallenge,
  readFicOAuthConfig,
} from "@/lib/fic/oauth";
import { oauthTokenResponseSchema } from "@/lib/fic/schemas";

const SECRET = "client-SECRET-0123456789";
const CODE = "code-ABCDEFGH-0123456789";
const VERIFIER = "verifier-0123456789-abcdefghijklmnopqrstuvwxyz";

const ENV = {
  FIC_CLIENT_ID: "vistato-client",
  FIC_CLIENT_SECRET: SECRET,
  FIC_REDIRECT_URI: "https://app.vistato.it/api/integrations/fic/callback",
};

const config: FicOAuthConfig = {
  clientId: "vistato-client",
  clientSecret: SECRET,
  redirectUri: "https://app.vistato.it/api/integrations/fic/callback",
  authorizeUrl: FIC_DEFAULT_OAUTH_AUTHORIZE_URL,
  tokenUrl: "https://fic.example/oauth/token",
};

const TOKENS = { token_type: "bearer", access_token: "a/ACCESS-123", refresh_token: "r/REFRESH-456", expires_in: 86400 };

function respond(status: number, body: string, contentType = "application/json"): typeof fetch {
  return (async () => new Response(body, { status, headers: { "Content-Type": contentType } })) as typeof fetch;
}

function expectNoSecret(error: unknown) {
  for (const text of [String(error), JSON.stringify(error), inspect(error), (error as Error).stack ?? ""]) {
    for (const secret of [SECRET, CODE, VERIFIER, "a/ACCESS-123", "r/REFRESH-456"]) expect(text).not.toContain(secret);
  }
}

describe("readFicOAuthConfig", () => {
  it("reads the required variables and defaults to the real FiC endpoints", () => {
    expect(readFicOAuthConfig(ENV)).toEqual({
      clientId: "vistato-client",
      clientSecret: SECRET,
      redirectUri: ENV.FIC_REDIRECT_URI,
      authorizeUrl: "https://api-v2.fattureincloud.it/oauth/authorize",
      tokenUrl: "https://api-v2.fattureincloud.it/oauth/token",
    });
    expect(FIC_DEFAULT_OAUTH_TOKEN_URL).toBe("https://api-v2.fattureincloud.it/oauth/token");
  });

  it("uses FIC_OAUTH_AUTHORIZE_URL and FIC_OAUTH_TOKEN_URL, http only towards localhost", () => {
    const local = readFicOAuthConfig({
      ...ENV,
      FIC_OAUTH_AUTHORIZE_URL: "http://127.0.0.1:3190/oauth/authorize",
      FIC_OAUTH_TOKEN_URL: "http://localhost:3190/oauth/token",
    });
    expect(local.authorizeUrl).toBe("http://127.0.0.1:3190/oauth/authorize");
    expect(local.tokenUrl).toBe("http://localhost:3190/oauth/token");
    expect(() => readFicOAuthConfig({ ...ENV, FIC_OAUTH_TOKEN_URL: "http://fic.example/oauth/token" })).toThrow(
      FicConfigError,
    );
  });

  it("refuses a missing or malformed variable naming the variable, never the value", () => {
    for (const [name, value] of [
    ["FIC_CLIENT_ID", ""],
    ["FIC_CLIENT_SECRET", undefined],
    ["FIC_REDIRECT_URI", "   "],
    ["FIC_CLIENT_SECRET", "with space"],
    ["FIC_REDIRECT_URI", "not a url"],
    ["FIC_REDIRECT_URI", "ftp://app.vistato.it/cb"],
    ["FIC_OAUTH_AUTHORIZE_URL", "https://user:pass@fic.example/oauth/authorize"],
    ["FIC_OAUTH_AUTHORIZE_URL", "https://fic.example/oauth/authorize?x=1"],
    ["FIC_OAUTH_TOKEN_URL", "https://fic.example/oauth/token#frag"],
    ] as [string, string | undefined][]) {
      const error = (() => {
        try {
          readFicOAuthConfig({ ...ENV, [name]: value });
        } catch (e) {
          return e;
        }
      })();
      expect(error, `${name}=${value}`).toBeInstanceOf(FicConfigError);
      expect((error as Error).message).toContain(name);
      if (value && value.trim()) expect((error as Error).message).not.toContain(value);
      expect((error as Error).message).not.toContain(SECRET);
    }
  });
});

describe("authorization request", () => {
  it("computes the S256 challenge of RFC 7636 (appendix B)", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("creates 256-bit random states and verifiers of 43 base64url characters, never repeated", () => {
    const states = new Set(Array.from({ length: 200 }, createOAuthState));
    expect(states.size).toBe(200);
    for (const state of states) expect(state).toMatch(FIC_OAUTH_STATE_PATTERN);
    const pair = createPkcePair();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).toBe(pkceChallenge(pair.verifier));
    expect(createPkcePair().verifier).not.toBe(pair.verifier);
  });

  it("builds the authorization URL with code, client, redirect, scope, state and the S256 challenge only", () => {
    const url = new URL(buildAuthorizationUrl(config, { state: "STATE", codeChallenge: "CHALLENGE" }));
    expect(`${url.origin}${url.pathname}`).toBe("https://api-v2.fattureincloud.it/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "vistato-client",
      redirect_uri: config.redirectUri,
      scope: FIC_OAUTH_SCOPE,
      state: "STATE",
      code_challenge: "CHALLENGE",
      code_challenge_method: "S256",
    });
    expect(url.href).not.toContain(SECRET);
  });

  it("asks for the scopes of the single constant, space-separated", () => {
    expect(FIC_OAUTH_SCOPES).toEqual(["received_documents:r"]);
    expect(FIC_OAUTH_SCOPE).toBe(FIC_OAUTH_SCOPES.join(" "));
  });

  it.each([
    ["a normal code", "abc-DEF_123.~/+=", true],
    ["an empty code", "", false],
    ["a code of 2048 characters", "c".repeat(2048), true],
    ["a code of 2049 characters", "c".repeat(2049), false],
    ["a code with a space", "a b", false],
    ["a code with CR/LF", "a\r\nb", false],
    ["a code with non-ASCII characters", "còde", false],
    ["a non-string", 5, false],
  ])("isPlausibleAuthorizationCode: %s → %s", (_label, code, expected) => {
    expect(isPlausibleAuthorizationCode(code)).toBe(expected);
  });
});

describe("oauthTokenResponseSchema", () => {
  it("accepts a FiC token response and ignores the other fields", () => {
    expect(oauthTokenResponseSchema.parse({ ...TOKENS, token_type: "Bearer", scope: "x" })).toEqual({
      accessToken: "a/ACCESS-123",
      refreshToken: "r/REFRESH-456",
      expiresInSeconds: 86400,
    });
  });

  it("refuses a response with a missing, malformed or oversized field", () => {
    for (const [label, body] of [
    ["no refresh token", { ...TOKENS, refresh_token: undefined }],
    ["an empty access token", { ...TOKENS, access_token: "" }],
    ["a token with a space", { ...TOKENS, access_token: "a b" }],
    ["a token over 4096 characters", { ...TOKENS, access_token: "a".repeat(4097) }],
    ["another token type", { ...TOKENS, token_type: "mac" }],
    ["expires_in as a string", { ...TOKENS, expires_in: "86400" }],
    ["expires_in zero", { ...TOKENS, expires_in: 0 }],
    ["expires_in decimal", { ...TOKENS, expires_in: 1.5 }],
    ["expires_in over 10 years", { ...TOKENS, expires_in: 400_000_000 }],
    ] as [string, unknown][]) {
      expect(oauthTokenResponseSchema.safeParse(body).success, label).toBe(false);
    }
  });
});

describe("exchangeAuthorizationCode", () => {
  it("POSTs JSON with the code, the verifier and the client credentials, without following redirects", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchStub = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(TOKENS), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const tokens = await exchangeAuthorizationCode(config, { code: CODE, codeVerifier: VERIFIER }, { fetch: fetchStub });
    expect(tokens).toEqual({ accessToken: "a/ACCESS-123", refreshToken: "r/REFRESH-456", expiresInSeconds: 86400 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(config.tokenUrl);
    expect(calls[0].init).toMatchObject({ method: "POST", redirect: "manual", cache: "no-store" });
    expect(new Headers(calls[0].init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      grant_type: "authorization_code",
      client_id: "vistato-client",
      client_secret: SECRET,
      redirect_uri: config.redirectUri,
      code: CODE,
      code_verifier: VERIFIER,
    });
  });

  it("does not send a malformed code", async () => {
    let called = false;
    const fetchStub = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    await expect(
      exchangeAuthorizationCode(config, { code: "a\r\nb", codeVerifier: VERIFIER }, { fetch: fetchStub }),
    ).rejects.toBeInstanceOf(FicInvalidArgumentError);
    expect(called).toBe(false);
  });

  it("throws on 400, 401 and 500, once (no retry), redacting secret, code and verifier", async () => {
    for (const [status, type] of [
      [400, FicHttpError],
      [401, FicHttpError],
      [500, FicServerError],
    ] as const) {
    let attempts = 0;
    const echo = JSON.stringify({ error: "invalid_grant", got: { client_secret: SECRET, code: CODE, code_verifier: VERIFIER } });
    const fetchStub = (async () => {
      attempts += 1;
      return new Response(echo, { status, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const error = await exchangeAuthorizationCode(config, { code: CODE, codeVerifier: VERIFIER }, { fetch: fetchStub }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(type);
    expect(attempts).toBe(1);
    expect((error as FicHttpError).status).toBe(status);
    expect((error as FicHttpError).bodyExcerpt).toContain("invalid_grant");
    expectNoSecret(error);
    }
  });

  it("refuses a 2xx not JSON, not matching the schema, too large or empty, keeping no part of the body", async () => {
    for (const [label, fetchStub] of [
    ["not JSON", respond(200, "<html>a/ACCESS-123</html>")],
    ["a text content type", respond(200, JSON.stringify(TOKENS), "text/plain")],
    ["a body not matching the schema", respond(200, JSON.stringify({ ...TOKENS, refresh_token: 5 }))],
    ["a body over 64 KB", respond(200, JSON.stringify({ ...TOKENS, pad: "x".repeat(70_000) }))],
    ["an empty body", respond(200, "")],
    ] as const) {
      const error = await exchangeAuthorizationCode(config, { code: CODE, codeVerifier: VERIFIER }, { fetch: fetchStub }).catch(
        (e: unknown) => e,
      );
      expect(error, label).toBeInstanceOf(FicInvalidResponseError);
      expect((error as FicInvalidResponseError).bodyExcerpt).toBe("[REDACTED]");
      expectNoSecret(error);
    }
  });

  it("reports a network error and a timeout as typed errors without secrets", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch;
    const network = await exchangeAuthorizationCode(config, { code: CODE, codeVerifier: VERIFIER }, { fetch: down }).catch(
      (e: unknown) => e,
    );
    expect(network).toBeInstanceOf(FicNetworkError);
    expect((network as FicNetworkError).code).toBe("ECONNREFUSED");
    expectNoSecret(network);

    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;
    const timeout = await exchangeAuthorizationCode(
      config,
      { code: CODE, codeVerifier: VERIFIER },
      { fetch: hang, timeoutMs: 20 },
    ).catch((e: unknown) => e);
    expect(timeout).toBeInstanceOf(FicTimeoutError);
    expectNoSecret(timeout);
  });
});
