import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import {
  FicConfigError,
  FicHttpError,
  FicInvalidArgumentError,
  FicInvalidResponseError,
  FicOAuthHttpError,
  FicServerError,
  FicTimeoutError,
} from "@/lib/fic/errors";
import {
  exchangeAuthorizationCode,
  type FicOAuthConfig,
  readFicOAuthConfig,
  refreshAccessToken,
  revokeToken,
} from "@/lib/fic/oauth";
import { oauthRefreshResponseSchema } from "@/lib/fic/schemas";

const SECRET = "client-SECRET-0123456789";
const REFRESH = "r/REFRESH-SECRET-456789";
const ACCESS = "a/ACCESS-SECRET-123456";

const ENV = {
  FIC_CLIENT_ID: "vistato-client",
  FIC_CLIENT_SECRET: SECRET,
  FIC_REDIRECT_URI: "https://app.vistato.it/api/integrations/fic/callback",
};

const config: FicOAuthConfig = {
  clientId: "vistato-client",
  clientSecret: SECRET,
  redirectUri: ENV.FIC_REDIRECT_URI,
  authorizeUrl: "https://fic.example/oauth/authorize",
  tokenUrl: "https://fic.example/oauth/token",
  revokeUrl: "https://fic.example/oauth/revoke",
};

interface Call {
  url: string;
  init: RequestInit;
}

function stub(status: number, body: string, contentType = "application/json") {
  const calls: Call[] = [];
  const fetchStub = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status, headers: { "Content-Type": contentType } });
  }) as unknown as typeof fetch;
  return { calls, fetchStub };
}

function expectNoSecret(error: unknown) {
  for (const text of [String(error), JSON.stringify(error), inspect(error), (error as Error).stack ?? ""]) {
    for (const secret of [SECRET, REFRESH, ACCESS, "REFRESH-SECRET", "ACCESS-SECRET"]) expect(text).not.toContain(secret);
  }
}

describe("readFicOAuthConfig: FIC_OAUTH_REVOKE_URL", () => {
  it("has no revocation endpoint unless FIC_OAUTH_REVOKE_URL is set, with the same URL rules", () => {
    expect(readFicOAuthConfig(ENV)).not.toHaveProperty("revokeUrl");
    expect(readFicOAuthConfig({ ...ENV, FIC_OAUTH_REVOKE_URL: "  " })).not.toHaveProperty("revokeUrl");
    expect(readFicOAuthConfig({ ...ENV, FIC_OAUTH_REVOKE_URL: "http://127.0.0.1:3190/oauth/revoke" }).revokeUrl).toBe(
      "http://127.0.0.1:3190/oauth/revoke",
    );
    for (const bad of ["http://fic.example/oauth/revoke", "https://u:p@fic.example/r", "https://fic.example/r?x=1", "nope"]) {
      expect(() => readFicOAuthConfig({ ...ENV, FIC_OAUTH_REVOKE_URL: bad }), bad).toThrow(FicConfigError);
    }
  });
});

describe("oauthRefreshResponseSchema", () => {
  const BODY = { token_type: "bearer", access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 };

  it("accepts a rotated refresh token, a missing one and a null one (no rotation)", () => {
    expect(oauthRefreshResponseSchema.parse(BODY)).toEqual({ accessToken: ACCESS, refreshToken: REFRESH, expiresInSeconds: 3600 });
    expect(oauthRefreshResponseSchema.parse({ ...BODY, refresh_token: undefined }).refreshToken).toBeNull();
    expect(oauthRefreshResponseSchema.parse({ ...BODY, refresh_token: null }).refreshToken).toBeNull();
  });

  it("refuses a missing access token, an empty or malformed refresh token, a bad expiry", () => {
    for (const [label, body] of [
      ["no access token", { ...BODY, access_token: undefined }],
      ["an empty refresh token", { ...BODY, refresh_token: "" }],
      ["a refresh token with a space", { ...BODY, refresh_token: "r x" }],
      ["no expires_in", { ...BODY, expires_in: undefined }],
      ["expires_in negative", { ...BODY, expires_in: -1 }],
      ["another token type", { ...BODY, token_type: "mac" }],
    ] as [string, unknown][]) {
      expect(oauthRefreshResponseSchema.safeParse(body).success, label).toBe(false);
    }
  });
});

describe("refreshAccessToken", () => {
  it("POSTs JSON grant_type=refresh_token with the client credentials, once, without following redirects", async () => {
    const { calls, fetchStub } = stub(
      200,
      JSON.stringify({ token_type: "bearer", access_token: ACCESS, refresh_token: "r/NEW", expires_in: 3600 }),
    );
    const tokens = await refreshAccessToken(config, { refreshToken: REFRESH }, { fetch: fetchStub });
    expect(tokens).toEqual({ accessToken: ACCESS, refreshToken: "r/NEW", expiresInSeconds: 3600 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(config.tokenUrl);
    expect(calls[0].init).toMatchObject({ method: "POST", redirect: "manual", cache: "no-store" });
    expect(new Headers(calls[0].init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      grant_type: "refresh_token",
      client_id: "vistato-client",
      client_secret: SECRET,
      refresh_token: REFRESH,
    });
  });

  it("returns a null refresh token when FiC does not rotate it", async () => {
    const { fetchStub } = stub(200, JSON.stringify({ token_type: "bearer", access_token: ACCESS, expires_in: 60 }));
    expect((await refreshAccessToken(config, { refreshToken: REFRESH }, { fetch: fetchStub })).refreshToken).toBeNull();
  });

  it("reports 400 invalid_grant and 401 as FicOAuthHttpError with the OAuth code, once, without secrets", async () => {
    for (const [status, code] of [
      [400, "invalid_grant"],
      [401, "invalid_client"],
      [400, undefined],
    ] as const) {
      const echo = JSON.stringify({ ...(code ? { error: code } : {}), got: { refresh_token: REFRESH, client_secret: SECRET } });
      const { calls, fetchStub } = stub(status, echo);
      const error = await refreshAccessToken(config, { refreshToken: REFRESH }, { fetch: fetchStub }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FicOAuthHttpError);
      expect(error).toBeInstanceOf(FicHttpError);
      expect(calls).toHaveLength(1);
      expect((error as FicOAuthHttpError).status).toBe(status);
      expect((error as FicOAuthHttpError).oauthError).toBe(code);
      expect((error as FicOAuthHttpError).toJSON()).toMatchObject({ oauthError: code, status });
      expectNoSecret(error);
    }
  });

  it("keeps no implausible OAuth error code (not a short code)", async () => {
    for (const code of ["x".repeat(65), "with space", "a\nb", 5]) {
      const { fetchStub } = stub(400, JSON.stringify({ error: code }));
      const error = await refreshAccessToken(config, { refreshToken: REFRESH }, { fetch: fetchStub }).catch((e: unknown) => e);
      expect((error as FicOAuthHttpError).oauthError, String(code)).toBeUndefined();
    }
  });

  it("reports a 500 as FicServerError, once (no retry), and an invalid 200 as FicInvalidResponseError without the body", async () => {
    const server = stub(503, JSON.stringify({ error: "server_error", refresh_token: REFRESH }));
    const error = await refreshAccessToken(config, { refreshToken: REFRESH }, { fetch: server.fetchStub }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FicServerError);
    expect(server.calls).toHaveLength(1);
    expectNoSecret(error);

    const invalid = stub(200, JSON.stringify({ token_type: "bearer", access_token: ACCESS }));
    const bad = await refreshAccessToken(config, { refreshToken: REFRESH }, { fetch: invalid.fetchStub }).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(FicInvalidResponseError);
    expect((bad as FicInvalidResponseError).bodyExcerpt).toBe("[REDACTED]");
    expectNoSecret(bad);
  });

  it("times out without leaking the refresh token", async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;
    const error = await refreshAccessToken(config, { refreshToken: REFRESH }, { fetch: hang, timeoutMs: 20 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FicTimeoutError);
    expectNoSecret(error);
  });

  it("refuses a refresh token that cannot be sent, without any request", async () => {
    for (const token of ["", "with space", "a\r\nb", "x".repeat(4097), "còdice"]) {
      const { calls, fetchStub } = stub(200, "{}");
      await expect(refreshAccessToken(config, { refreshToken: token }, { fetch: fetchStub })).rejects.toBeInstanceOf(
        FicInvalidArgumentError,
      );
      expect(calls).toHaveLength(0);
    }
  });

  it("the code exchange still reports a 400 as FicHttpError (now with the OAuth code)", async () => {
    const { fetchStub } = stub(400, JSON.stringify({ error: "invalid_grant" }));
    const error = await exchangeAuthorizationCode(config, { code: "abc", codeVerifier: "v" }, { fetch: fetchStub }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FicHttpError);
    expect((error as FicOAuthHttpError).oauthError).toBe("invalid_grant");
  });
});

describe("revokeToken", () => {
  it("POSTs an RFC 7009 form with token, hint and client credentials to the revocation endpoint", async () => {
    const { calls, fetchStub } = stub(200, "");
    await revokeToken(config, { token: REFRESH, hint: "refresh_token" }, { fetch: fetchStub });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(config.revokeUrl);
    expect(calls[0].init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(new Headers(calls[0].init.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(calls[0].init.body as string))).toEqual({
      token: REFRESH,
      token_type_hint: "refresh_token",
      client_id: "vistato-client",
      client_secret: SECRET,
    });
  });

  it("sends nothing without a revocation endpoint (FicConfigError) or with a token that cannot be sent", async () => {
    const { calls, fetchStub } = stub(200, "");
    const noEndpoint: FicOAuthConfig = { ...config, revokeUrl: undefined };
    await expect(revokeToken(noEndpoint, { token: REFRESH, hint: "refresh_token" }, { fetch: fetchStub })).rejects.toBeInstanceOf(
      FicConfigError,
    );
    await expect(revokeToken(config, { token: "a b", hint: "access_token" }, { fetch: fetchStub })).rejects.toBeInstanceOf(
      FicInvalidArgumentError,
    );
    expect(calls).toHaveLength(0);
  });

  it("reports a refusal without the token or the client secret", async () => {
    const { fetchStub } = stub(400, JSON.stringify({ error: "unsupported_token_type", token: ACCESS, secret: SECRET }));
    const error = await revokeToken(config, { token: ACCESS, hint: "access_token" }, { fetch: fetchStub }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FicOAuthHttpError);
    expect((error as FicOAuthHttpError).oauthError).toBe("unsupported_token_type");
    expectNoSecret(error);
  });
});
