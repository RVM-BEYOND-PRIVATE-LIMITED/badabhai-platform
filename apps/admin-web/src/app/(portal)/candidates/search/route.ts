import { z } from "zod";
import { searchCandidates } from "../../../../lib/candidate-search-server";
import {
  CANDIDATE_SEARCH_SORTS,
  normalizeSearchTerm,
} from "../../../../lib/candidate-search";
import {
  isAdminForbidden,
  isAdminRequestError,
  isAdminUnauthorized,
} from "../../../../lib/admin-http";
import {
  isJsonRequest,
  isSameOriginRequest,
  readBodyText,
} from "../../../../lib/same-origin-request";

/**
 * `POST /candidates/search` — the universal search box's same-origin read (A7, #2577).
 *
 * The term `q` travels in this POST's BODY ONLY — never in a URL, route, error or validation
 * message (ADR-0062 §3.6: the term must never reach a log line, and access logs record URLs).
 * That is why the list page itself never reads `?q=`: it renders the bare-filters list from
 * the address, and the box POSTs its debounced term here from the browser.
 *
 * ── WHAT IT ANSWERS ───────────────────────────────────────────────────────────────
 * The first page of matches as SLIM rows — id, disclosed name, city, trade, status — plus
 * the exact total and which identity lookup ran (`q_type`: `name` / `phone` / null, never
 * the term). No facets, no salary, no resume state: the dropdown shows eight rows and the
 * total, each row opening the drawer (`?c=<id>`); the full row stays on the list.
 *
 * ── SECURITY ──────────────────────────────────────────────────────────────────────
 * Same guards as the phone reveal (`../[id]/phone/route.ts`): same-origin, JSON body, a
 * bounded read, then the request itself — a term of 1–200 chars with the page's filters,
 * sort and paging. The API holds every control (the `read_candidates` gate, the SEARCH cap,
 * the identity audit and budget); this route only carries the operator's keystrokes to it
 * server-side, and answers a bare status on failure — never the API's text.
 */
export const dynamic = "force-dynamic";

/** The largest body read: a term plus the page's filters, all operator-typed. */
const MAX_BODY_BYTES = 8192;

/** The dropdown's page: the API's smallest page, sliced to the rows shown. */
const DROPDOWN_PAGE_SIZE = 25;
const DROPDOWN_ROWS = 8;

const searchRequestSchema = z
  .object({
    q: z.string().min(1).max(200),
    filters: z.record(z.string(), z.unknown()).optional(),
    sort: z.enum(CANDIDATE_SEARCH_SORTS).optional(),
    dir: z.enum(["asc", "desc"]).optional(),
    page: z.number().int().min(1).optional(),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) return refuse(403, "forbidden");
  if (!isJsonRequest(request)) return refuse(415, "refused");
  const text = await readBodyText(request, MAX_BODY_BYTES);
  if (text === null) return refuse(413, "too_large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse(400, "refused");
  }
  const parsed = searchRequestSchema.safeParse(body);
  if (!parsed.success) return refuse(400, "refused");
  const term = normalizeSearchTerm(parsed.data.q);
  if (!term) return refuse(400, "refused");

  try {
    const res = await searchCandidates({
      q: term,
      ...(parsed.data.filters ? { filters: parsed.data.filters } : {}),
      sort: parsed.data.sort ?? "last_active_at",
      dir: parsed.data.dir ?? "desc",
      page: parsed.data.page ?? 1,
      page_size: DROPDOWN_PAGE_SIZE,
    });
    return Response.json(
      {
        status: "ok",
        total: res.total,
        q_type: res.q_type,
        candidates: res.candidates.slice(0, DROPDOWN_ROWS).map((c) => ({
          worker_id: c.worker_id,
          ...(Object.hasOwn(c, "name") ? { name: c.name ?? null } : {}),
          status: c.status,
          current_city: c.current_city,
          current_state: c.current_state,
          trade_label: c.trade_label ?? c.role_label ?? c.domain_label,
          profile_status: c.profile_status,
        })),
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (isAdminUnauthorized(err)) return refuse(401, "signed_out");
    if (isAdminForbidden(err)) return refuse(403, "forbidden");
    if (isAdminRequestError(err) && (err.status === 404 || err.status === 400)) {
      return refuse(404, "not_found");
    }
    return refuse(502, "error");
  }
}

function refuse(status: number, error: string): Response {
  return Response.json({ status: error }, { status, headers: { "Cache-Control": "no-store" } });
}
