/**
 * "Reached N workers" — the post-publish confirmation (demo liveness).
 *
 * Neither publish response carries a reach count (`PATCH /payer/job-postings/:id` returns the
 * posting; the server's `MaterializeResult` counts are not echoed). The count therefore comes from
 * `POST /payer/match/reach-preview` with the SAME selection, read right after the publish lands —
 * the same eligible-pool computation the publish just materialized. See {@link reachAfterPublish}
 * (server side, in `published-reach.server.ts`).
 *
 * The count rides the landing URL as `?reached=N` so the confirmation survives the navigation. It
 * is the payer's OWN view of their OWN posting — a hand-edited value misleads nobody else — but it
 * is still parsed strictly: anything that is not a whole number ≥ 0 shows NOTHING, never a guess.
 */
export const PUBLISHED_REACH_PARAM = "reached";

/** `path` with the reach count attached, or `path` unchanged when there is no count to show. */
export function withPublishedReach(path: string, reached: number | null | undefined): string {
  if (reached === null || reached === undefined || !Number.isSafeInteger(reached) || reached < 0) {
    return path;
  }
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}${PUBLISHED_REACH_PARAM}=${reached}`;
}

/** The `?reached=` value as a count, or null when absent / not a whole number ≥ 0. */
export function parsePublishedReach(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || !/^\d{1,9}$/.test(value)) return null;
  return Number(value);
}

/**
 * The confirmation reads "Reached <N> <unit>" — "Reached 1 worker" / "Reached 12 workers". The
 * figure is its own piece, because the notice counts it up (#2585); the unit is the FINAL count's.
 */
export function formatReach(reached: number): string {
  return reached.toLocaleString("en-IN");
}

/** "worker" for one, "workers" otherwise. */
export function reachUnit(reached: number): "worker" | "workers" {
  return reached === 1 ? "worker" : "workers";
}
