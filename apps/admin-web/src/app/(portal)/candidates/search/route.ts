import {
  isAdminForbidden,
  isAdminRequestError,
  isAdminUnauthorized,
} from "../../../../lib/admin-http";
import { candidateSearchRequestSchema, searchCandidates } from "../../../../lib/candidate-search";
import {
  isJsonRequest,
  isSameOriginRequest,
  readBodyText,
} from "../../../../lib/same-origin-request";

/**
 * `POST /candidates/search` — one page of the candidate data bank, for the Candidates list (A7,
 * #2577). The browser sends the search term in this request's BODY; this route forwards the same
 * body to `POST /admin/candidates/search` with the admin's httpOnly session (`adminFetch`), so the
 * term is never written into a page URL, a route path, an error message or a log line
 * (ADR-0062 §3.6).
 *
 * ── WHY A ROUTE AND NOT A SERVER ACTION ────────────────────────────────────────────────
 * The same reason as the drawer's record read (`[id]/record/route.ts`): Next runs a server action
 * through the router's queue, and a URL change made while one is pending discards it and schedules
 * a full refresh — on this screen a refresh would re-read up to 100 names against the admin's
 * hourly budget. A plain fetch runs beside the next, can be aborted when the operator types
 * again, and never re-renders the page.
 *
 * ── WHAT IT ANSWERS ────────────────────────────────────────────────────────────────────
 * `{ ok: true, data }` with the API's parsed page, or `{ ok: false, reason, error }` where
 * `reason` is the list's own machine state (`refused`, `limited`, `forbidden`, `signed_out`,
 * `error`). The API's 400 text is passed through because it explains a refusal to an already
 * authenticated operator; nothing else from the API is echoed. `Cache-Control: no-store` on every
 * answer — a row may carry a decrypted name.
 */
export const dynamic = "force-dynamic";

/** The largest body read: a term of 200 characters and the filters are far inside this. */
const MAX_BODY_BYTES = 64 * 1024;

export type CandidateSearchRouteResult =
  | { ok: true; data: unknown }
  | {
      ok: false;
      reason: "refused" | "limited" | "forbidden" | "signed_out" | "error";
      error: string;
    };

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return answer(403, {
      ok: false,
      reason: "forbidden",
      error: "A search can only be started from the Candidates page.",
    });
  }
  if (!isJsonRequest(request)) {
    return answer(415, {
      ok: false,
      reason: "refused",
      error: "A search must be sent as a JSON request.",
    });
  }
  const text = await readBodyText(request, MAX_BODY_BYTES);
  if (text === null) {
    return answer(413, {
      ok: false,
      reason: "refused",
      error: "That search is too large.",
    });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    return answer(400, {
      ok: false,
      reason: "refused",
      error: "That search could not be read.",
    });
  }

  const parsed = candidateSearchRequestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return answer(400, {
      ok: false,
      reason: "refused",
      error: "One of the filters or the search term is not one this page accepts.",
    });
  }

  try {
    const data = await searchCandidates(
      { ...parsed.data, filters: parsed.data.filters ?? {} },
      request.signal,
    );
    return answer(200, { ok: true, data });
  } catch (err) {
    if (isAdminUnauthorized(err)) {
      return answer(401, {
        ok: false,
        reason: "signed_out",
        error: "Your session has ended. Sign in again to search candidates.",
      });
    }
    if (isAdminForbidden(err)) {
      return answer(403, {
        ok: false,
        reason: "forbidden",
        error:
          "Phone-number searches require name access for your role. Search a name, trade, city or profile field instead.",
      });
    }
    if (isAdminRequestError(err)) {
      if (err.status === 400) {
        return answer(400, { ok: false, reason: "refused", error: err.message });
      }
      if (err.status === 429) {
        return answer(429, {
          ok: false,
          reason: "limited",
          error: "Too many searches in this window. Wait a moment and try again.",
        });
      }
      if (err.status === 404) {
        return answer(404, {
          ok: false,
          reason: "refused",
          error: "The search route was not found.",
        });
      }
    }
    return answer(502, {
      ok: false,
      reason: "error",
      error: "The candidate data bank did not answer. That is a fault on our side.",
    });
  }
}

function answer(status: number, result: CandidateSearchRouteResult): Response {
  return Response.json(result, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
