import { postFicCompany } from "@/lib/fic-connection/http";

/** Chooses the FiC company to link among the saved ones (OWNER or ADMIN, `pending_company_selection`). */
export async function POST(request: Request) {
  return postFicCompany(request);
}
