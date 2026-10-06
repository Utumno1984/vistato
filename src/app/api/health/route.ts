import { getSql } from "@/db/client";
import { buildLinks, resource } from "@/lib/hateoas";

type CheckStatus = "up" | "down";

async function checkDatabase(): Promise<CheckStatus> {
  try {
    await getSql()`select 1`;
    return "up";
  } catch {
    return "down";
  }
}

/** Liveness and readiness: 200 when every dependency is reachable, 503 otherwise. */
export async function GET() {
  const database = await checkDatabase();
  const healthy = database === "up";
  return Response.json(
    resource(
      { status: healthy ? "ok" : "degraded", checks: { database } },
      buildLinks([{ rel: "self", link: { href: "/api/health" }, allowed: true }]),
    ),
    { status: healthy ? 200 : 503 },
  );
}
