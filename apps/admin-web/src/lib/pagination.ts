/**
 * The numbered pager's arithmetic (A4, #2574) — "1–50 of 24,310 · ‹ 1 2 3 … 487 ›".
 *
 * ONLY FOR A LIST WHOSE API ANSWERS AN EXACT TOTAL. Every admin list today is keyset-paged
 * (`{ items, nextCursor }`, no total — apps/api/src/admin/*), so they page First / Next
 * (`components/pager.tsx`); numbers over a cursor would promise a stable page 3 that does not
 * exist. The data-bank lists (#2577 Candidates, #2578 User accounts, #2579 Companies) are specified
 * with numbered pages and an exact total, and render `NumberedPager` from these.
 *
 * Pure, so the pager stays a server-safe component and every rule here is testable on its own.
 */

/** One slot of a numbered pager: a page number, or the ellipsis standing for a run of pages. */
export type PageSlot = number | "gap";

/** The last page of `total` rows at `pageSize` per page — at least 1, so an empty list has a page 1. */
export function lastPage(pageSize: number, total: number): number {
  if (!(pageSize > 0) || !(total > 0)) return 1;
  return Math.ceil(total / pageSize);
}

/**
 * The 1-based rows page `page` holds: `{ from: 1, to: 50 }` of 24,310 at 50 a page. Null when the
 * page holds no row (an empty list, or a page past the end), so a caller never prints "51–50".
 */
export function pageRange(
  page: number,
  pageSize: number,
  total: number,
): { from: number; to: number } | null {
  if (!(pageSize > 0) || !(total > 0) || !(page >= 1)) return null;
  const from = (Math.trunc(page) - 1) * pageSize + 1;
  if (from > total) return null;
  return { from, to: Math.min(from + pageSize - 1, total) };
}

/**
 * The page numbers a numbered pager shows: always the first and the last, the current page and
 * one each side of it, and an ellipsis for every longer run between — "1 2 3 … 487" on page 1,
 * "1 … 9 10 11 … 487" on page 10. At either end the window holds three pages, so the edge never
 * reads "1 2 … 487". A run of ONE hidden page is shown as that page, never as an ellipsis: "…" in
 * the place of a single number hides nothing and costs a click.
 *
 * `current` is clamped into 1..last for the window only — a stale address past the end still gets
 * a pager that leads back into the list.
 */
export function pageWindow(current: number, last: number): PageSlot[] {
  const end = Math.max(1, Math.trunc(last));
  if (end === 1) return [1];
  const page = Math.min(Math.max(1, Math.trunc(current) || 1), end);

  const shown = new Set<number>([1, end, page - 1, page, page + 1]);
  if (page <= 2) [2, 3].forEach((n) => shown.add(n));
  if (page >= end - 1) [end - 1, end - 2].forEach((n) => shown.add(n));

  const pages = [...shown].filter((n) => n >= 1 && n <= end).sort((a, b) => a - b);
  const out: PageSlot[] = [];
  let previous = 0;
  for (const n of pages) {
    if (n - previous === 2) out.push(previous + 1);
    else if (n - previous > 2) out.push("gap");
    out.push(n);
    previous = n;
  }
  return out;
}
