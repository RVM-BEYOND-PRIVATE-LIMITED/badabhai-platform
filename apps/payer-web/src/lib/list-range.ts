/**
 * WHERE A PAGE OF A KEYSET-PAGED LIST STARTS, and the "Showing 21–40 of 57" it reads as (#2588).
 *
 * The Candidates lists page by an opaque cursor (`nextCursor`): no response says which row a page
 * starts at, and the cursor's contents are the server's business, never read here. So the portal
 * counts for itself: the first page starts at 1, and "Next page" carries `from` — this page's start
 * plus the rows it showed. A later page reached any other way (an old bookmark, a hand-edited link)
 * has no start, and then says no range rather than a guessed one.
 *
 * PURE: no I/O, no React — the pages work it out on the server.
 */

/** The query key "Next page" carries: the 1-based position of that page's first row. */
export const FROM_PARAM = "from";

/** Far past any list a payer pages through — bounds a hand-edited value. */
const MAX_START = 1_000_000;

/**
 * Where this page starts: 1 on the first page (no cursor). A later page starts where the pager's
 * `from` says — a whole number of at least 2, since a cursor never points at the first row — and
 * anything else there is unknown (null).
 */
export function pageStart(
  raw: string | string[] | undefined,
  cursor: string | null,
): number | null {
  if (cursor === null) return 1;
  if (typeof raw !== "string" || !/^[1-9]\d{0,6}$/.test(raw)) return null;
  const start = Number(raw);
  return start >= 2 && start <= MAX_START ? start : null;
}

/** The rows one page shows, 1-based and inclusive, and the list's size when it is known. */
export interface ListRange {
  first: number;
  last: number;
  /** How many rows the whole list holds; null when the API does not say. */
  total: number | null;
}

/**
 * The range a page shows: `start` to `start + rows - 1`, of `total` when the list's size is known.
 * Null when the start is unknown, the page is empty, or the range runs past the total — a link that
 * outlived the list it counted (the pool shrank since) is not a position worth printing.
 */
export function listRange(
  start: number | null,
  rows: number,
  total: number | null,
): ListRange | null {
  if (start === null || rows < 1) return null;
  const last = start + rows - 1;
  if (total !== null && last > total) return null;
  return { first: start, last, total };
}

/** "Showing 21–40 of 57" · "Showing 57 of 57" (a one-row page) · "Showing 21–40" (no total). */
export function rangeLabel({ first, last, total }: ListRange): string {
  const span = first === last ? `${first}` : `${first}–${last}`;
  return total === null ? `Showing ${span}` : `Showing ${span} of ${total}`;
}

/** Where the page after this one starts — what its "Next page" link carries. */
export function nextStart(range: ListRange): number {
  return range.last + 1;
}
