"use client";

import Link from "next/link";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Icon } from "@badabhai/icons";
import { NavPendingCue } from "./nav-pending";
import { pendingNavigation, subscribeNavigation } from "./nav-pending-store";
import { openDrawerEntry } from "./drawer";
import { GridViewControls } from "./grid-view-controls";
import { useColumnChoices, useDensityChanges, useGridDensity } from "./grid-preferences";
import {
  gridMinWidthRem,
  headerMayCut,
  headerWidthRem,
  visibleColumns,
  type GridColumnMeta,
} from "./data-grid-model";

/** One row as the view draws it — every cell already rendered by the server-side `DataGrid`. */
export interface GridViewRow {
  key: string;
  /** The row's own page. Its link-column cell becomes the row's one link, stretched over the row. */
  href?: string;
  /** The row in words: "Opening {name}…" while its page loads. */
  name?: string;
  /** The link's accessible name, where its visible cell is not one (a dash for a missing name). */
  label?: string;
  /** One per column, in the column order the view was given. */
  cells: readonly ReactNode[];
  /** What follows each cell — outside the row link in the link's column (a copy button). */
  trails: readonly ReactNode[];
  /** A cut cell's full text, for its `title`, by column (truncating columns only). */
  titles: readonly (string | undefined)[];
}

export interface DataGridViewProps {
  gridId: string;
  caption: string;
  columns: readonly GridColumnMeta[];
  rows: readonly GridViewRow[];
  /** The column holding each row's link, when the rows link to a page of their own. */
  linkColumn?: string;
  /** The search param of the drawer each row opens over this list, instead of a page (A7). */
  linkDrawer?: string;
  pager?: ReactNode;
  variant?: "prose";
  viewControls: boolean;
}

/**
 * THE DATA GRID's client half (A4, #2574) — see `components/data-grid.tsx` for the contract a page
 * writes against. This half owns what only the browser knows:
 *
 *  - THE VIEWER'S VIEW: the columns they chose and the row density (`grid-preferences.ts`). Hidden
 *    columns are not drawn at all, so a row never carries a cell its header does not.
 *  - THE PENDING STATE: while a navigation is under way the table is `aria-busy`, its rows dim to
 *    60% (the clicked row stays bright) and a 2px shimmer runs under the column header. It reads the
 *    console's ONE navigation store (`nav-pending-store.ts`), written by the cue on whatever started
 *    the navigation — a filter bar's Apply, a chip, the pager, a sort header, a row link — so it
 *    shows after the same 180ms as the rest of the pending cue (a prefetched navigation never
 *    flashes it), with no loading boundary (app/no-loading-boundary-anywhere.test.ts), and it ends
 *    the moment the new rows commit.
 *  - WHETHER THE TABLE FITS: measured, not guessed. A grid that fits its box clips sideways, so its
 *    header can stick under the topbar while the PAGE scrolls; one that does not scrolls sideways in
 *    its own box (globals.css, the A4 block). Until measured — the server render — it scrolls.
 */
export function DataGridView({
  gridId,
  caption,
  columns,
  rows,
  linkColumn,
  linkDrawer,
  pager,
  variant,
  viewControls,
}: DataGridViewProps) {
  const pending = useSyncExternalStore(subscribeNavigation, pendingNavigation, pendingNavigation);
  const density = useGridDensity();
  const densityChanges = useDensityChanges();
  const choices = useColumnChoices(gridId);

  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const fits = useFits(scrollRef, tableRef);

  // A new set of rows (a filter, a page) starts at its first row. In the fill layout the grid's
  // own body is what was scrolled, and a navigation resets only the window — so "Next page" from
  // the bottom of page 1 would otherwise open page 2 at its last rows. Instant: a scroll position
  // is never animated.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [rows]);

  const shown = visibleColumns(
    columns.map((column, index) => ({ ...column, index })),
    choices,
  );
  const linked = linkColumn !== undefined && shown.some((c) => c.id === linkColumn);
  const span = shown.length + (linked ? 1 : 0);
  const minWidth = { "--grid-min": `${gridMinWidthRem(shown, linked)}rem` } as CSSProperties;

  return (
    <div
      className={variant === "prose" ? "grid grid--prose" : "grid"}
      data-density={density}
      // A density change re-enters the rows with their 140ms fade — the brief's "row height
      // animates" done in opacity, the only property (with transform) this console animates; the
      // height itself snaps. Each change swaps the fade's keyframes (globals.css), which restarts
      // it on the rows as they are: nothing remounts, so a row's own state — a role being chosen,
      // an action's outcome — survives. The density a page loads with is no change.
      data-replay={densityChanges > 0 ? (densityChanges % 2 === 1 ? "odd" : "even") : undefined}
      data-fit={fits ? "true" : "false"}
    >
      <div className="grid__scroll" ref={scrollRef}>
        <table
          className={variant === "prose" ? "table table--prose grid__table" : "table grid__table"}
          ref={tableRef}
          aria-busy={pending !== null ? true : undefined}
          style={minWidth}
        >
          <caption className="sr-only">{caption}</caption>
          <colgroup>
            {shown.map((c) => (
              <col
                key={c.id}
                className={`grid__col grid__col--${c.width}`}
                // A fixed kind is drawn at least as wide as its header (globals.css): a long
                // label ("Questions settled") over a short value is never cut.
                style={c.width === "fill" ? undefined : headerWidth(c)}
              />
            ))}
            {linked ? <col className="grid__col grid__col--end" /> : null}
          </colgroup>
          <thead>
            <tr>
              {shown.map((c) => (
                <HeaderCell key={c.id} column={c} />
              ))}
              {linked ? <th className="grid__end" aria-hidden="true" /> : null}
            </tr>
            {/* The pending shimmer's track, directly under the header and sticky with it. */}
            <tr className="grid__progress-row" aria-hidden="true">
              <td className="grid__progress-cell" colSpan={span}>
                <span className="grid__progress" />
              </td>
            </tr>
          </thead>
          <tbody onClick={linked ? openRowFromCell : undefined}>
            {rows.map((row) => (
              <tr key={row.key}>
                {shown.map((c) => {
                  const content = row.cells[c.index];
                  const trail = row.trails[c.index];
                  const title = row.titles[c.index];
                  const Cell = c.rowHeader ? "th" : "td";
                  if (linked && row.href && c.id === linkColumn) {
                    return (
                      <Cell
                        key={c.id}
                        className={cellClass(c, true)}
                        scope={c.rowHeader ? "row" : undefined}
                      >
                        <RowLink row={row} href={row.href} title={title} drawer={linkDrawer}>
                          {content}
                        </RowLink>
                        {trail}
                      </Cell>
                    );
                  }
                  // A cut cell's full text rides on its TEXT, not the cell: the cell sits under the
                  // row's stretched link, its text above it (globals.css), so only there can the
                  // title ever show on hover.
                  return (
                    <Cell
                      key={c.id}
                      className={cellClass(c, false)}
                      scope={c.rowHeader ? "row" : undefined}
                    >
                      {title !== undefined ? (
                        <span className="grid__cell-text" title={title}>
                          {content}
                        </span>
                      ) : (
                        content
                      )}
                      {trail}
                    </Cell>
                  );
                })}
                {linked ? (
                  <td className="grid__end" aria-hidden="true">
                    {row.href ? <Icon name="caret-right" /> : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pager || viewControls ? (
        <div className="grid__footer">
          {pager ? <div className="grid__pager">{pager}</div> : null}
          {viewControls ? (
            <GridViewControls
              gridId={gridId}
              columns={columns}
              choices={choices}
              density={density}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The row's ONE link: the name in its own cell, its `::after` stretched over the whole row
 * (globals.css), so the row is a single click target and a single tab stop. The other controls in
 * the row (a copy button, a customer link) sit above the stretch and keep their own targets; so
 * does a cell's title-bearing text, whose plain click `openRowFromCell` hands back to this link.
 * The cue announces "Opening {name}…" after the console's delay — which is also what dims the
 * rest of the grid while this row stays bright.
 */
function RowLink({
  row,
  href,
  title,
  drawer,
  children,
}: {
  row: GridViewRow;
  href: string;
  title: string | undefined;
  /** The drawer this row opens over the list (its search param), when it opens one. */
  drawer?: string;
  children: ReactNode;
}) {
  return (
    <Link
      className="grid__link"
      href={href}
      aria-label={row.label}
      data-drawer-value={drawer ? (drawerValueOf(href, drawer) ?? undefined) : undefined}
      onNavigate={drawer ? (event) => openRowDrawer(event, href, drawer) : undefined}
    >
      <span className="grid__link-text" title={title}>
        {children}
      </span>
      <NavPendingCue message={`Opening ${row.name ?? "the row"}…`} />
    </Link>
  );
}

/**
 * A row that opens a drawer over its list (A7, #2577): Next was about to navigate to the row's
 * `?<drawer>=<id>` address — stop it, and take the address in place instead (`openDrawerEntry`),
 * so the drawer opens at once over a list that is neither re-read nor scrolled. Next calls this
 * only for a plain click it would handle itself; a new-tab or modified click never gets here and
 * follows the href, where the drawer opens with the page.
 */
export function openRowDrawer(
  event: { preventDefault(): void },
  href: string,
  drawer: string,
  open: (href: string, param: string) => void = openDrawerEntry,
): void {
  event.preventDefault();
  open(href, drawer);
}

/** The value a drawer row's link opens its drawer at — its own href's `?<drawer>=`. */
function drawerValueOf(href: string, drawer: string): string | null {
  return new URL(href, "http://row.invalid").searchParams.get(drawer);
}

/** What `drawerRowLink` searches — the page (`document`) in the browser. */
export interface RowLinkScope {
  querySelectorAll(selectors: string): ArrayLike<HTMLElement>;
}

const pageScope: RowLinkScope = {
  querySelectorAll: (selectors) => document.querySelectorAll<HTMLElement>(selectors),
};

/**
 * The row link on this page that opens its drawer at `value` (A7, #2577), or null when that row
 * is not on the page — where focus belongs when the drawer closes. After ↑/↓ that is the row the
 * drawer was moved to, not the one that opened it: a keyboard scan resumes where it stopped.
 * Each drawer row's link carries the value its own href opens (`data-drawer-value`).
 */
export function drawerRowLink(value: string, scope: RowLinkScope = pageScope): HTMLElement | null {
  const links = Array.from(scope.querySelectorAll("a.grid__link[data-drawer-value]"));
  return links.find((link) => link.dataset.drawerValue === value) ?? null;
}

/** What in a row is a control of its own: a click on one is that control's, never the row's. */
const ROW_CONTROLS = "a, button, input, select, textarea, summary, label, [role='button']";

/**
 * A click that lands in a linked row but not on its link: on a cell's own text — lifted above the
 * stretched link so its `title` shows (an exact instant, a full id, a cut name) and it can be
 * selected — or anywhere in a row whose stretch is out of the hit test while it shows an overlay
 * (globals.css). A plain primary click there still opens the row: it is handed to the row's
 * link, so the navigation, its pending cue and the client router stay the link's own. Left alone:
 * a click on a control of its own (a copy button, a customer link), one with a modifier or
 * another button (the link itself takes those), and one that ends a text selection.
 */
export function openRowFromCell(event: ReactMouseEvent<HTMLElement>): void {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target = event.target as Element | null;
  if (!target || typeof target.closest !== "function" || target.closest(ROW_CONTROLS)) return;
  const link = target.closest("tr")?.querySelector<HTMLAnchorElement>("a.grid__link");
  if (!link) return;
  const selection = typeof window === "undefined" ? null : window.getSelection();
  if (selection && !selection.isCollapsed && selection.toString().trim() !== "") return;
  link.click();
}

/** A fixed column's header width, for the stylesheet to take the wider of it and the kind. */
function headerWidth(column: GridColumnMeta): CSSProperties {
  return { "--col-head": `${headerWidthRem(column.header, column.sort !== undefined)}rem` } as CSSProperties;
}

/**
 * A column header — plain text, or the link that orders the list by this column. Its label wraps
 * onto a second line rather than run into its neighbour; a text column's header, which can be
 * squeezed past even that, carries its full label in a `title` (`headerMayCut`).
 */
function HeaderCell({ column }: { column: GridColumnMeta }) {
  const sort = column.sort;
  const title = headerMayCut(column) ? column.header : undefined;
  const label = <span className="grid__head">{column.header}</span>;
  if (!sort)
    return (
      <th scope="col" title={title}>
        {label}
      </th>
    );
  return (
    <th scope="col" aria-sort={sort.direction} title={title}>
      <Link
        className="grid__sort"
        href={sort.href}
        data-direction={sort.direction ?? "none"}
        scroll={false}
      >
        {label}
        <span className="sr-only">, {sort.label}</span>
        <Icon name="sort-descending" className="grid__sort-icon" />
        <NavPendingCue message="Sorting the list…" />
      </Link>
    </th>
  );
}

function cellClass(column: GridColumnMeta, link: boolean): string | undefined {
  const classes = [
    // The hook every row header in the console carries (`.table tbody th`, globals.css).
    column.rowHeader ? "table__rowhead" : null,
    column.text === "truncate" ? "grid__cell--truncate" : null,
    column.text === "wrap" ? "grid__cell--wrap" : null,
    link ? "grid__cell--link" : null,
    column.className ?? null,
  ].filter(Boolean);
  return classes.length > 0 ? classes.join(" ") : undefined;
}

/**
 * Whether the table fits its box: re-measured whenever either one changes size (a resized window,
 * a column shown or hidden, the sidebar rail opening). `false` until the first measurement, so the
 * server render — and a browser without ResizeObserver — scrolls sideways rather than clipping.
 */
function useFits(
  scroll: RefObject<HTMLDivElement | null>,
  table: RefObject<HTMLTableElement | null>,
): boolean {
  const [fits, setFits] = useState(false);
  useEffect(() => {
    const box = scroll.current;
    const grid = table.current;
    if (!box || !grid || typeof ResizeObserver === "undefined") return;
    const measure = () => setFits(grid.offsetWidth <= box.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [scroll, table]);
  return fits;
}
