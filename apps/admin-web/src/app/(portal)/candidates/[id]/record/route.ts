import {
  readCandidateRecord,
  type CandidateRecordStatus,
} from "../../../../../lib/candidate-detail";

/**
 * `GET /candidates/<id>/record` — ONE candidate's #2560 record, for the Candidates drawer (A7,
 * #2577). A same-origin read the drawer makes from the browser when a row opens it or ↑/↓ moves
 * it; the page itself reads the same record on the server when it loads with `?c=<id>`.
 *
 * ── WHY A ROUTE AND NOT A SERVER ACTION ─────────────────────────────────────────────────
 * The drawer lives in the address (`?c=<id>`) and changes it with the history API, so the list
 * under it is never re-rendered (on Candidates a re-render re-reads 50 names against the admin's
 * hourly name budget). Next runs server actions through the router's queue, and a URL change made
 * while one is pending DISCARDS it and schedules a full refresh of the page — a ↓ pressed while a
 * record loads would have re-read the whole list. A plain fetch never enters that queue, can be
 * aborted when the drawer moves on, and runs beside the next. The drawer's phone reveal is a route
 * for the same reason (`../phone/route.ts`, which also makes the server action's own checks).
 *
 * ── AN ABORTED READ ─────────────────────────────────────────────────────────────────────
 * The incoming request's signal is passed to the API call (`readCandidateRecord` → `adminFetch`),
 * so a drawer that moved on cancels it — if it has not reached the API yet. A read that has is
 * audited (`admin.candidate_viewed`) and charged a name all the same, whatever happens to the
 * answer: the API records the view before it reads anything. That is why the drawer lets a burst
 * of ↑/↓ settle before it reads at all (`RECORD_SETTLE_MS`).
 *
 * ── SECURITY ────────────────────────────────────────────────────────────────────────────
 *  - Same as every portal read: the admin JWT is read from the httpOnly cookie and sent to the API
 *    server-side (`adminFetch`); it never reaches the browser. The API enforces `read_candidates`,
 *    names behind `read_identity` + the budget, and audits the view before it reads anything.
 *  - The session cookie is SameSite=strict, so a request another SITE starts carries no session.
 *    SameSite is per site, not per origin: a page on another `localhost` port (the portal is
 *    reached on loopback) is the same site, and its request DOES carry the cookie. A browser marks
 *    such a request `same-site` (another site's `cross-site`), and either is refused here before
 *    any read. An older browser marks nothing, so such a page can make the read — never see its
 *    answer (the portal grants no CORS), but for a worker id it already knows the API audits it
 *    and spends a name. A GET has no body to hold to JSON, the rule that closes this gap for the
 *    phone reveal (`lib/same-origin-request.ts`).
 *  - `Cache-Control: no-store`: the body may carry a decrypted name.
 *  - The body is the record or a bare status — never the API's error text.
 */
export const dynamic = "force-dynamic";

const HTTP_STATUS: Readonly<Record<CandidateRecordStatus, number>> = {
  ok: 200,
  not_found: 404,
  forbidden: 403,
  signed_out: 401,
  error: 502,
};

/** `Sec-Fetch-Site` values a same-origin drawer read can carry; absent means an older browser. */
const ALLOWED_FETCH_SITES = new Set(["same-origin", "none"]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && !ALLOWED_FETCH_SITES.has(site)) {
    return Response.json(
      { status: "forbidden" },
      { status: HTTP_STATUS.forbidden, headers: { "Cache-Control": "no-store" } },
    );
  }
  const { id } = await params;
  const result = await readCandidateRecord(id, request.signal);
  return Response.json(result, {
    status: HTTP_STATUS[result.status],
    headers: { "Cache-Control": "no-store" },
  });
}
