import Link from "next/link";
import { Icon } from "@badabhai/icons";
import { NavPendingCue } from "./nav-pending";
import { InfoPopover } from "./info-popover";
import { formatCount } from "../lib/format";
import { lastPage, pageRange, pageWindow } from "../lib/pagination";

/**
 * The keyset pager, shared by every entity list: "First page" past page one, "Next page" while
 * there is one. Drawn in the data grid's footer bar (`DataGrid`'s `pager` slot).
 *
 * The cursor is dropped from the base params and re-added from THIS page's response, so cursors
 * never stack and changing a filter always restarts at page one. Applying page three's cursor to
 * a brand-new query returns an arbitrary slice of it, which looks like data rather than like an
 * error. "First page" is the same query with no cursor at all — every filter kept.
 *
 * There is no "previous" link and no page numbers, deliberately: a keyset cursor only moves
 * forward, and rendering 1·2·3 over a table that is being appended to would promise a stable
 * pagination that does not exist. A list whose API answers an exact total pages with
 * {@link NumberedPager} instead (A4, #2574).
 *
 * `cursor` is the cursor in the current address. It is required (it may be undefined) so a caller
 * cannot forget it; on the first page there is nothing to go back to.
 */
export function Pager({
  basePath,
  params,
  cursor,
  nextCursor,
  note = "Paging uses a keyset cursor, so rows arriving mid-scan cannot skip or repeat.",
}: {
  basePath: string;
  /** The active filters, WITHOUT any cursor. */
  params: Record<string, string | undefined>;
  cursor: string | undefined;
  nextCursor: string | null | undefined;
  note?: string;
}) {
  if (!nextCursor && !cursor) return null;

  const href = (pageCursor?: string) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    if (pageCursor) q.set("cursor", pageCursor);
    const s = q.toString();
    return s ? `${basePath}?${s}` : basePath;
  };

  return (
    <nav className="pager" aria-label="Pages">
      {cursor ? (
        <Link className="btn btn--ghost btn--sm" href={href()}>
          <Icon name="caret-double-left" />
          First page
          <NavPendingCue message="Loading the first page…" />
        </Link>
      ) : null}
      {nextCursor ? (
        <Link className="btn btn--ghost btn--sm" href={href(nextCursor)}>
          Next page
          <Icon name="caret-right" />
          {/* The next page is the same page with a new cursor: it shows that it is under way, with
              no boundary (components/nav-pending.tsx). */}
          <NavPendingCue message="Loading the next page…" />
        </Link>
      ) : null}
      {/* Why there are no page numbers — one click away (A3's caveat rule), not a line of its own
          in the footer bar. */}
      <InfoPopover label="About paging">
        <p>{note}</p>
      </InfoPopover>
    </nav>
  );
}

/**
 * The numbered pager — "1–50 of 24,310 · ‹ 1 2 3 … 487 ›" — for a list whose API answers an
 * EXACT TOTAL and pages by number (A4, #2574; the data-bank lists, #2577–#2579). Never over a
 * keyset cursor (see {@link Pager}). The page window is `pageWindow` (lib/pagination.ts).
 *
 * Every page is a link to the same query with a new page number: the filters travel, the current
 * page is `aria-current="page"` text, and each link carries the navigation cue. Server-safe.
 */
export function NumberedPager({
  basePath,
  params,
  page,
  pageSize,
  total,
  pageParam = "page",
  onSelectPage,
}: {
  basePath: string;
  /** The active filters (and page size), WITHOUT the page number. */
  params: Record<string, string | undefined>;
  /** The page on screen, 1-based. */
  page: number;
  pageSize: number;
  /** The API's exact total for these filters. */
  total: number;
  /** The query parameter that carries the page number. */
  pageParam?: string;
  /**
   * Paging handled in place (A7, #2577's client data bank): every page becomes a button and the
   * list re-reads in this browser, so a search term that is body-only stays in the query. Absent
   * on a server-paged list, where each page is a link to the same query with a new number.
   */
  onSelectPage?: (page: number) => void;
}) {
  if (!(total > 0)) return null;
  const last = lastPage(pageSize, total);
  const range = pageRange(page, pageSize, total);

  const href = (n: number) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v && k !== pageParam) q.set(k, v);
    if (n > 1) q.set(pageParam, String(n));
    const s = q.toString();
    return s ? `${basePath}?${s}` : basePath;
  };

  return (
    <nav className="pager pager--numbered" aria-label="Pages">
      <p className="pager__range">
        {range
          ? `${formatCount(range.from)}–${formatCount(range.to)} of ${formatCount(total)}`
          : `No rows on this page · ${formatCount(total)} in all`}
      </p>
      <span className="pager__sep" aria-hidden="true">
        ·
      </span>
      <ol className="pager__pages">
        <li>
          {page > 1 ? (
            onSelectPage ? (
              <button
                type="button"
                className="pager__step"
                onClick={() => onSelectPage(Math.min(page - 1, last))}
              >
                <Icon name="caret-left" />
                <span className="sr-only">Previous page</span>
              </button>
            ) : (
              <Link className="pager__step" href={href(Math.min(page - 1, last))}>
                <Icon name="caret-left" />
                <span className="sr-only">Previous page</span>
                <NavPendingCue message="Loading the previous page…" />
              </Link>
            )
          ) : (
            <span className="pager__step" aria-disabled="true">
              <Icon name="caret-left" />
              <span className="sr-only">Previous page</span>
            </span>
          )}
        </li>
        {pageWindow(page, last).map((slot, i) =>
          slot === "gap" ? (
            <li className="pager__gap" key={`gap-${i}`} aria-hidden="true">
              …
            </li>
          ) : (
            <li key={slot}>
              {slot === page ? (
                <span className="pager__page" aria-current="page">
                  {formatCount(slot)}
                </span>
              ) : onSelectPage ? (
                <button type="button" className="pager__page" onClick={() => onSelectPage(slot)}>
                  <span className="sr-only">Page </span>
                  {formatCount(slot)}
                </button>
              ) : (
                <Link className="pager__page" href={href(slot)}>
                  <span className="sr-only">Page </span>
                  {formatCount(slot)}
                  <NavPendingCue message={`Loading page ${formatCount(slot)}…`} />
                </Link>
              )}
            </li>
          ),
        )}
        <li>
          {page < last ? (
            onSelectPage ? (
              <button type="button" className="pager__step" onClick={() => onSelectPage(page + 1)}>
                <Icon name="caret-right" />
                <span className="sr-only">Next page</span>
              </button>
            ) : (
              <Link className="pager__step" href={href(page + 1)}>
                <Icon name="caret-right" />
                <span className="sr-only">Next page</span>
                <NavPendingCue message="Loading the next page…" />
              </Link>
            )
          ) : (
            <span className="pager__step" aria-disabled="true">
              <Icon name="caret-right" />
              <span className="sr-only">Next page</span>
            </span>
          )}
        </li>
      </ol>
    </nav>
  );
}
