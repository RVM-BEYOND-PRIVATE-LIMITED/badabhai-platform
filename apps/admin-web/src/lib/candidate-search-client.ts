import type { CandidateSearchQuery, CandidateSearchResponse } from "./candidate-search-model";

/**
 * The browser's read of the data bank (A7, #2577): a plain `fetch` of the same-origin
 * `POST /candidates/search` route, which forwards the body to the admin API. No server-only
 * import — this runs in the list component.
 *
 * A failed read is a VALUE, not a throw, so every way it can fail has its own list state. The
 * only rejection is the caller's own abort (the operator typed again): nobody reads that answer.
 */
export type CandidateSearchResult =
  | { ok: true; data: CandidateSearchResponse }
  | {
      ok: false;
      reason: "refused" | "limited" | "forbidden" | "signed_out" | "error";
      error: string;
    };

export async function fetchCandidateSearch(
  query: CandidateSearchQuery,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<CandidateSearchResult> {
  try {
    const body = {
      ...(query.q?.trim() ? { q: query.q.trim() } : {}),
      filters: query.filters,
      sort: query.sort,
      dir: query.dir,
      page: query.page,
      page_size: query.page_size,
    };
    const res = await fetchImpl("/candidates/search", {
      method: "POST",
      cache: "no-store",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const payload: unknown = await res.json();
    if (typeof payload !== "object" || payload === null) {
      return { ok: false, reason: "error", error: "The candidate data bank did not answer." };
    }
    const envelope = payload as { ok?: unknown; data?: unknown; reason?: unknown; error?: unknown };
    if (envelope.ok === true && typeof envelope.data === "object" && envelope.data !== null) {
      return { ok: true, data: envelope.data as CandidateSearchResponse };
    }
    const reason =
      envelope.reason === "refused" ||
      envelope.reason === "limited" ||
      envelope.reason === "forbidden" ||
      envelope.reason === "signed_out" ||
      envelope.reason === "error"
        ? envelope.reason
        : "error";
    return {
      ok: false,
      reason,
      error:
        typeof envelope.error === "string" && envelope.error.trim() !== ""
          ? envelope.error
          : "The candidate data bank did not answer.",
    };
  } catch (err) {
    if (signal.aborted) throw err;
    return {
      ok: false,
      reason: "error",
      error: "The candidate data bank is unreachable. That is a fault on our side.",
    };
  }
}
