import type { FakeFicCalls, FakeFicScenario, FakeFicTokenCalls } from "./server";

/**
 * Settings of the fake Fatture in Cloud of the e2e suite, shared by `playwright.config.ts`
 * (environment of the web server), the global setup (which starts it) and the specs.
 */
export const FAKE_FIC_PORT = 3190;
export const FAKE_FIC_URL = `http://127.0.0.1:${FAKE_FIC_PORT}`;

/** The `state` Vistato put in an authorization URL. */
export function stateOf(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("authorization URL without state");
  return state;
}

/** Configures what the fake does for the authorization request with this `state`. */
export async function configureFakeFic(state: string, scenario: FakeFicScenario, baseUrl = FAKE_FIC_URL) {
  const res = await fetch(`${baseUrl}/__fake/scenarios/${encodeURIComponent(state)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(scenario),
  });
  if (!res.ok) throw new Error(`fake FiC: scenario not accepted (${res.status})`);
}

/** The refresh and revocation requests the fake received for the authorization with this `state`. */
export async function fakeFicTokenCalls(state: string, baseUrl = FAKE_FIC_URL): Promise<FakeFicTokenCalls> {
  const res = await fetch(`${baseUrl}/__fake/token-calls/${encodeURIComponent(state)}`);
  if (!res.ok) throw new Error(`fake FiC: token calls not available (${res.status})`);
  return (await res.json()) as FakeFicTokenCalls;
}

/** The calls the fake received for the authorization request with this `state`. */
export async function fakeFicCalls(state: string, baseUrl = FAKE_FIC_URL): Promise<FakeFicCalls> {
  const res = await fetch(`${baseUrl}/__fake/calls/${encodeURIComponent(state)}`);
  if (!res.ok) throw new Error(`fake FiC: calls not available (${res.status})`);
  return (await res.json()) as FakeFicCalls;
}
