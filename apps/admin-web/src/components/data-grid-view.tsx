"use client";

import Link from "next/link";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { Icon } from "@badabhai/icons";
import { NavPendingCue } from "./nav-pending";
import { pendingNavigation, subscribeNavigation } from "./nav-pending-store";
import { GridViewControls } from "./grid-view-controls";
import { useColumnChoices, useGridDensity } from "./grid-preferences";
import { gridMinWidthRem, visibleColumns, type GridColumnMeta } from "./data-grid-model";

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
  pager,
  variant,
  viewControls,
}: DataGridViewProps) {
  const pending = useSyncExternalStore(subscribeNavigation, pendingNavigation, pendingNavigation);
  const density = useGridDensity();
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
              <col key={c.id} className={`grid__col grid__col--${c.width}`} />
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
          {/* Keyed on the density: a density change re-enters the rows with their 140ms fade —
              the brief's "row height animates" done in opacity, the only property (with
              transform) this console animates. The height itself snaps. */}
          <tbody key={density}>
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
                        <RowLink row={row} href={row.href} title={title}>
                          {content}
                        </RowLink>
                        {trail}
                      </Cell>
                    );
                  }
                  return (
                    <Cell
                      key={c.id}
                      className={cellClass(c, false)}
                      scope={c.rowHeader ? "row" : undefined}
                      title={title}
                    >
                      {content}
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
 * the row (a copy button, a customer link) sit above the stretch and keep their own targets. The
 * cue announces "Opening {name}…" after the console's delay — which is also what dims the rest of
 * the grid while this row stays bright.
 */
function RowLink({
  row,
  href,
  title,
  children,
}: {
  row: GridViewRow;
  href: string;
  title: string | undefined;
  children: ReactNode;
}) {
  return (
    <Link className="grid__link" href={href} aria-label={row.label}>
      <span className="grid__link-text" title={title}>
        {children}
      </span>
      <NavPendingCue message={`Opening ${row.name ?? "the row"}…`} />
    </Link>
  );
}

/** A column header — plain text, or the link that orders the list by this column. */
function HeaderCell({ column }: { column: GridColumnMeta }) {
  const sort = column.sort;
  if (!sort) return <th scope="col">{column.header}</th>;
  return (
    <th scope="col" aria-sort={sort.direction}>
      <Link
        className="grid__sort"
        href={sort.href}
        data-direction={sort.direction ?? "none"}
        scroll={false}
      >
        {column.header}
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
