import { getFicIntegration } from "@/lib/fic-connection/http";

/** State of the tenant's Fatture in Cloud link (any role, module `fic_iban_alert`). Never a token. */
export async function GET(request: Request) {
  return getFicIntegration(request);
}
