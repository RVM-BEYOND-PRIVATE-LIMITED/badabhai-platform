import type { ReactNode } from "react";
import { DataGridView, type GridViewRow } from "./data-grid-view";
import type { GridColumnMeta, GridColumnWidth, GridSort } from "./data-grid-model";

export type { GridColumnWidth, GridSort } from "./data-grid-model";

/**
 * One column of a list, as a page declares it. `cell` runs on the SERVER (this file has no hooks),
 * so a cell may render anything a page can — a `StatusPill`, a `CopyId`, a `CustomerLink`.
 */
export interface GridColumn<Row> {
  /** Stable key — the viewer's show/hide choice for the column is stored under it. */
  id: string;
  /** The header text, and the column's name in the column chooser. */
  header: string;
  /** What KIND of column it is, which decides its width (`GridColumnWidth`). Default `fill`. */
  width?: GridColumnWidth;
  /**
   * How a long value behaves. `truncate` (the default for a `fill` column): one line, cut with an
   * ellipsis, the full text in the cell's `title` (give it with `title`). `wrap`: every line.
   */
  text?: "truncate" | "wrap";
  /** The cell. In the row link's column, the link's content — the row's name. */
  cell: (row: Row) => ReactNode;
  /**
   * Drawn after `cell` in the same cell, and OUTSIDE the row link in the link's column: a copy
   * button (a button inside a link is invalid markup and swallows the link's click), a version tag.
   */
  trail?: (row: Row) => ReactNode;
  /** The full text of a cut cell — its `title`, so nothing is ever only an ellipsis. */
  title?: (row: Row) => string | undefined;
  /** Extra class on each body cell (`table__meta`, `ui-num`, `cell--message`, …). */
  className?: string;
  /** The viewer may not hide it. The row link's column is always locked. */
  locked?: boolean;
  /** Hidden until the viewer shows it in the column chooser. */
  defaultHidden?: boolean;
  /** The column chooser's heading for it (#2577 groups Identity / Work / Activity / Account). */
  group?: string;
  /** Its cells label their rows (`th scope="row"`) — at most one column, usually the link's. */
  rowHeader?: boolean;
  /** A header that orders the list by this column (the list's own sort parameter, in the URL). */
  sort?: GridSort;
}

/** Where a row leads: its own page, through the cell that names it. */
export interface GridRowLink<Row> {
  /** The column whose cell is the row's NAME — the primary link. Locked visible. */
  column: string;
  href: (row: Row) => string;
  /** The row in words — "Opening Ramesh Kumar…" while its page loads. */
  name: (row: Row) => string;
  /** The link's accessible name where its visible cell says nothing (a dash for "no name"). */
  label?: (row: Row) => string | undefined;
  /**
   * The row opens a DRAWER over this list instead of a page (A7, #2577): the search param the
   * drawer is addressed by (`"c"` — `href` then carries `?c=<id>` with the list's own query).
   * A plain click updates the address in place, shallow, so the list is not re-read and does not
   * move (`openDrawerEntry`); a new-tab click still follows `href`, which opens the drawer there.
   * Each row link names the value it opens (`data-drawer-value`), so the drawer can hand focus
   * back to the row it is ON when it closes (`drawerRowLink`).
   */
  drawer?: string;
}

export interface DataGridProps<Row> {
  /** Stable, unique per list ("workers", "postings") — the key of the viewer's column choices. */
  id: string;
  /** What the rows are, for assistive tech ("Workers, newest first"). */
  caption: string;
  columns: readonly GridColumn<Row>[];
  /** The rows to draw — a page renders its own empty, refused and failed states instead. */
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** The row's own page, when it has one: the whole row becomes that ONE link. */
  rowLink?: GridRowLink<Row>;
  /** The pager — `Pager` (keyset) or `NumberedPager` (an exact total) — in the footer bar. */
  pager?: ReactNode;
  /** `prose`: a table of sentences (Feedback) — rows top-aligned, its prose cells wrap. */
  variant?: "prose";
  /** The column chooser and the density toggle. Off for a small fixed table (a dashboard panel). */
  viewControls?: boolean;
}

/**
 * THE DATA GRID (A4, #2574) — the one way a list page draws its rows. Every list in the console
 * renders this; the Candidates (#2577), User accounts (#2578) and Companies (#2579) tabs are built
 * on it. What a page gets by declaring columns:
 *
 *  - ONE VERTICAL SCROLLER. On a tall desktop a list page (`page page--list`) fills the window:
 *    its header and filters stay put, the grid's body is the page's one scroller and the pager
 *    sits in the footer bar. Everywhere else the page itself is the one scroller, the column
 *    header sticks under the topbar and the footer bar under the rows — never a scroller inside a
 *    scroller that traps the wheel (globals.css, the A4 block).
 *  - WIDTHS BY KIND (ID 10ch, status 10ch, date 12ch, …), text columns sharing what is left and
 *    cutting long values with an ellipsis and a `title`; a table too wide for its box scrolls
 *    sideways in its own box, never the page.
 *  - THE ROW AS ONE LINK (`rowLink`): the name is the link, stretched over the row — one click
 *    target, one tab stop — with an end chevron. Other controls in the row keep their own targets.
 *  - A PAGER SLOT, the PENDING STATE (aria-busy, rows dimmed, a shimmer under the header — after
 *    the console's 180ms, with no loading boundary), a sortable header (`sort`), and the viewer's
 *    COLUMN CHOOSER and DENSITY toggle (44 / 36px rows), kept in their own browser.
 *
 * Server-safe: no hooks. It evaluates the cells here and hands the client view plain data.
 */
export function DataGrid<Row>({
  id,
  caption,
  columns,
  rows,
  rowKey,
  rowLink,
  pager,
  variant,
  viewControls = true,
}: DataGridProps<Row>) {
  const meta = gridColumnMeta(columns, rowLink?.column);

  const viewRows: GridViewRow[] = rows.map((row) => {
    const label = rowLink?.label?.(row);
    return {
      key: rowKey(row),
      ...(rowLink ? { href: rowLink.href(row), name: rowLink.name(row) } : {}),
      ...(label ? { label } : {}),
      cells: columns.map((c) => c.cell(row)),
      trails: columns.map((c) => c.trail?.(row)),
      titles: columns.map((c) => c.title?.(row)),
    };
  });

  return (
    <DataGridView
      gridId={id}
      caption={caption}
      columns={meta}
      rows={viewRows}
      linkColumn={rowLink?.column}
      linkDrawer={rowLink?.drawer}
      pager={pager}
      variant={variant}
      viewControls={viewControls}
    />
  );
}

/**
 * A page's columns as the client view takes them: every default made explicit (a `fill` column
 * truncates), the row link's column locked visible. Exported for tests that measure a real
 * column set (the Postings 1440px fit).
 */
export function gridColumnMeta<Row>(
  columns: readonly GridColumn<Row>[],
  linkColumn?: string,
): GridColumnMeta[] {
  return columns.map((c) => {
    const width = c.width ?? "fill";
    return {
      id: c.id,
      header: c.header,
      width,
      text: c.text ?? (width === "fill" ? "truncate" : undefined),
      locked: c.locked === true || c.id === linkColumn,
      defaultHidden: c.defaultHidden === true && c.id !== linkColumn,
      ...(c.group ? { group: c.group } : {}),
      ...(c.className ? { className: c.className } : {}),
      ...(c.rowHeader ? { rowHeader: true } : {}),
      ...(c.sort ? { sort: c.sort } : {}),
    };
  });
}
