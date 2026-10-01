import { redirect } from "next/navigation";
import { requirePayer } from "../../../lib/auth";
import { HIRING_CAPACITY_HREF } from "../../../lib/billing-routes";

export const dynamic = "force-dynamic";

/**
 * /capacity — KEPT AS A ROUTE, RENDERED NOWHERE (2026-10-01).
 *
 * It used to be a second page carrying the same capacity tiles, the same `CapacityPanel` and the
 * same per-posting table as Plans & capacity. Hiring capacity now lives in ONE place — the
 * section of /plans it redirects to (`/plans#hiring-capacity`) — and this route stays so old
 * links and bookmarks still land somewhere real (the same pattern as /profile → /account). Links
 * inside the app point at the section directly (`HIRING_CAPACITY_HREF`).
 *
 * Plans & capacity is company-only (it sells entitlements on company postings), so an agent is
 * sent to the dashboard rather than bounced through /plans. The session gate runs first; nothing
 * is read here.
 */
export default async function CapacityPage() {
  const session = await requirePayer();
  redirect(session.role === "agent" ? "/dashboard" : HIRING_CAPACITY_HREF);
}
