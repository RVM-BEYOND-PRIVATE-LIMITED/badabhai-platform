import type { DriveCursor } from "./campus-drive-cursor";

/** A request of Campus's feed, by its position: `changedKey` is its microsecond `updated_at`. */
export interface FeedRequestKey {
  id: string;
  changedKey: string;
}

/** An erasure of Campus's feed (#2811), by its position: `erasedKey` is its microsecond time. */
export interface FeedErasureKey {
  id: string;
  erasedKey: string;
}

/** One page, split back by kind, each part still in feed order. */
export interface MergedDriveFeed<R, E> {
  requests: R[];
  erasures: E[];
  /** The position of the last entry served (either kind): the next cursor's key. */
  last: DriveCursor | undefined;
  /** True when either source had an entry past this page. */
  hasMore: boolean;
}

type Entry<R, E> = { at: string; id: string } & (
  | { kind: "request"; row: R }
  | { kind: "erasure"; row: E }
);

/**
 * The feed's ONE order: the time (microsecond UTC text, fixed width, so it compares as text exactly
 * as `timestamptz` compares in Postgres), then the id (lower-case uuid text, which compares as the
 * `uuid` type does). The SQL keyset `(time, id) > (cursor)` reads both sources in this order.
 */
function compare(a: { at: string; id: string }, b: { at: string; id: string }): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * #2811 — MERGE THE TWO SOURCES OF CAMPUS'S FEED into one page: the requests
 * (`listFeed`, by `updated_at`) and the erasures of deleted requests (`listErasures`, by
 * `erased_at`). Each source was read after the SAME cursor with `limit + 1` rows, so the first
 * `limit` entries of their merge are the first `limit` of the whole stream: nothing is skipped and
 * nothing repeated across pages. The page is then split back by kind, each part in feed order.
 *
 * One cursor serves both (the existing `campus` cursor, unchanged): it is the last served entry's
 * `(time, id)`, whichever kind it was. A request id and an erasure id never name two different
 * rows at one position (an erased id no longer exists in the requests table), so the keyset stays
 * a total order.
 */
export function mergeDriveFeed<R extends FeedRequestKey, E extends FeedErasureKey>(
  requests: readonly R[],
  erasures: readonly E[],
  limit: number,
): MergedDriveFeed<R, E> {
  const entries: Entry<R, E>[] = [
    ...requests.map((row) => ({ kind: "request" as const, at: row.changedKey, id: row.id, row })),
    ...erasures.map((row) => ({ kind: "erasure" as const, at: row.erasedKey, id: row.id, row })),
  ].sort(compare);
  const page = entries.slice(0, limit);
  const last = page[page.length - 1];
  return {
    requests: page.flatMap((e) => (e.kind === "request" ? [e.row] : [])),
    erasures: page.flatMap((e) => (e.kind === "erasure" ? [e.row] : [])),
    last: last === undefined ? undefined : { at: last.at, id: last.id },
    hasMore: entries.length > limit,
  };
}
