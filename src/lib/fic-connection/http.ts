import "server-only";

import { z } from "zod";

import { requireSession, type AuthContext } from "@/lib/auth/session";
import { ficIbanAlertAccess, requireFicIbanAlert, type FicIbanAlertNeed } from "@/lib/fic-iban-alert/access";
import { errorResponse, invalidRequest, zodIssues } from "@/lib/http/errors";

import { FIC_SETTINGS_PATH, ficSettingsUrl } from "./outcomes";
import { loadFicIntegrationResource } from "./resource";
import {
  completeFicConnection,
  FicNotConfiguredError,
  selectFicCompany,
  startFicConnection,
  type FicConnectionDeps,
} from "./service";

/**
 * The `/api/integrations/fic/*` endpoints. Order of the checks, for every endpoint: session
 * (401; the callback redirects to the login instead), origin of a POST (403
 * `forbidden_origin`), module `fic_iban_alert` (403 `module_not_active`), role for the
 * actions (403 `forbidden`: OWNER and ADMIN only), then the request itself.
 */

const NO_STORE = { "Cache-Control": "no-store" };

/** Anti-abuse cap on the body of `POST /company` (`{"companyId": <id>}` is a few bytes). */
export const SELECT_COMPANY_MAX_BODY_BYTES = 1024;

async function guard(request: Request, need: FicIbanAlertNeed): Promise<AuthContext | Response> {
  const auth = await requireSession(request);
  if (auth instanceof Response) return auth;
  return requireFicIbanAlert(auth, need);
}

function notConfigured(): Response {
  return errorResponse(503, "fic_not_configured", "Il collegamento a Fatture in Cloud non è configurato su questo server");
}

/** `GET /api/integrations/fic`: the state of the link, for every role of a tenant with the module. */
export async function getFicIntegration(request: Request): Promise<Response> {
  const auth = await guard(request, "read");
  if (auth instanceof Response) return auth;
  const access = await ficIbanAlertAccess(auth);
  return Response.json(await loadFicIntegrationResource(auth.scope, access), { headers: NO_STORE });
}

/** `POST /api/integrations/fic/connect`: 200 `{ authorizationUrl }`, 409 when a connection exists. */
export async function postFicConnect(request: Request, deps: FicConnectionDeps = {}): Promise<Response> {
  const auth = await guard(request, "manage");
  if (auth instanceof Response) return auth;
  try {
    const result = await startFicConnection(auth, deps);
    if ("error" in result) {
      return errorResponse(409, "already_connected", "La tua azienda è già collegata a Fatture in Cloud");
    }
    return Response.json({ authorizationUrl: result.authorizationUrl }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof FicNotConfiguredError) return notConfigured();
    throw error;
  }
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      ...NO_STORE,
      // The callback URL carries the code: it must not leak to the next page as a Referer.
      "Referrer-Policy": "no-referrer",
    },
  });
}

/**
 * `GET /api/integrations/fic/callback`: the browser comes back from FiC (top-level navigation,
 * so the SameSite=Lax session cookie is there). Always a 303 to the settings page with
 * `?esito=<code>`; without a session a 303 to the login, which leads back to the settings.
 */
export async function getFicCallback(request: Request, deps: FicConnectionDeps = {}): Promise<Response> {
  const auth = await requireSession(request);
  if (auth instanceof Response) {
    // The state is left untouched: the user can log in and start again from the settings.
    if (auth.status === 401) return redirect(`/login?next=${encodeURIComponent(FIC_SETTINGS_PATH)}`);
    return auth;
  }
  const allowed = await requireFicIbanAlert(auth, "manage");
  if (allowed instanceof Response) return allowed;
  const outcome = await completeFicConnection(auth, new URL(request.url).searchParams, deps);
  return redirect(ficSettingsUrl(outcome));
}

const selectCompanyBodySchema = z.object({
  companyId: z.number({ error: "companyId deve essere un numero" }).int("companyId deve essere un intero").positive("companyId deve essere positivo"),
});

/** The body as text, or null as soon as it exceeds the limit. */
async function readLimitedText(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** `POST /api/integrations/fic/company` `{ companyId }`: completes a pending connection. */
export async function postFicCompany(request: Request): Promise<Response> {
  const auth = await guard(request, "manage");
  if (auth instanceof Response) return auth;

  const text = await readLimitedText(request, SELECT_COMPANY_MAX_BODY_BYTES);
  if (text === null) {
    return errorResponse(413, "payload_too_large", "Il corpo della richiesta supera la dimensione massima di 1 KB");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return invalidRequest([{ field: "body", message: "Il corpo della richiesta non è un JSON valido" }]);
  }
  const parsed = selectCompanyBodySchema.safeParse(body);
  if (!parsed.success) return invalidRequest(zodIssues(parsed.error));

  const result = await selectFicCompany(auth, parsed.data.companyId);
  switch (result.outcome) {
    case "connected": {
      const access = await ficIbanAlertAccess(auth);
      return Response.json(await loadFicIntegrationResource(auth.scope, access, result.connection), {
        headers: NO_STORE,
      });
    }
    case "unknown_company":
      return errorResponse(400, "unknown_company", "L'azienda scelta non è tra quelle del tuo account Fatture in Cloud", {
        issues: [{ field: "companyId", message: "Azienda non disponibile" }],
      });
    case "company_already_linked":
      return errorResponse(
        409,
        "company_already_linked",
        "Questa azienda di Fatture in Cloud è già collegata a un altro account Vistato",
      );
    case "not_pending":
      return errorResponse(409, "company_selection_not_pending", "Non c'è nessuna azienda da scegliere");
  }
}
