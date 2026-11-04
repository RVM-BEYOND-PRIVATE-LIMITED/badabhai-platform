/**
 * The data grid's vocabulary (A4, #2574) — pure and serializable, shared by the server-side
 * `DataGrid` (components/data-grid.tsx), which evaluates a page's column definitions, and the
 * client-side `DataGridView` (components/data-grid-view.tsx), which draws them. Nothing here holds
 * a function or touches the DOM, so it crosses the server/client boundary as plain data.
 */

/**
 * How wide a column is drawn. A closed set: the widths live in globals.css (`.grid__col--*`, the
 * A4 block), in `ch` of the table's own type, so a page names a KIND of column and never a size.
 *
 *  - `fill`     — a text column (a title, a name, a label): takes its share of what the fixed
 *                 columns leave, and ellipsizes. The default.
 *  - `id`       — a short id with its copy button: "5eed…0001 ⧉" (10ch of id).
 *  - `customer` — `CustomerLink`: the short id, its copy button and the persona ("Company").
 *  - `typed-id` — a type tag (cut at 12ch, its full name in `title`), then a short id and its copy
 *                 button: an event's actor or subject.
 *  - `status`   — one status pill of up to 10 characters.
 *  - `date`     — "3d ago" / "19 Aug 2026" (12ch).
 *  - `number`   — a count, a delta or a short code (8ch).
 *  - `money`    — a ₹ figure or a pay band (14ch).
 *  - `short`    — a short label: a language, a build, a pack, a provider (14ch).
 *  - `actions`  — a stacked cluster of row controls (the admin directory's).
 */
export type GridColumnWidth =
  | "fill"
  | "id"
  | "customer"
  | "typed-id"
  | "status"
  | "date"
  | "number"
  | "money"
  | "short"
  | "actions";

/** A sortable column header: where a click goes, and this column's order when it sorts the list. */
export interface GridSort {
  /** The list ordered the other way by this column (or by it at all) — the header's link. */
  href: string;
  /** This column's current order; absent when the list is not sorted by it. */
  direction?: "ascending" | "descending";
  /** What the click does, for assistive tech after the header's own words ("oldest first"). */
  label: string;
}

/** A column as the client view needs it: everything but the cell renderer. */
export interface GridColumnMeta {
  /** Stable key — the column chooser stores the viewer's choice under it. */
  id: string;
  /** The header text, and the column's name in the column chooser. */
  header: string;
  width: GridColumnWidth;
  /** `truncate`: one line, cut with an ellipsis. `wrap`: as many lines as the text needs. */
  text?: "truncate" | "wrap";
  /** The viewer cannot hide it — the row link's column always is. */
  locked: boolean;
  /** Hidden until the viewer shows it in the column chooser. */
  defaultHidden: boolean;
  /** The heading the chooser lists the column under (#2577: Identity / Work / Activity / Account). */
  group?: string;
  /** Extra class on each of the column's body cells (`table__meta`, `ui-num`, `cell--message`, …). */
  className?: string;
  /** Its cells LABEL their rows (`th scope="row"`) — at most one column, usually the link's. */
  rowHeader?: boolean;
  sort?: GridSort;
}

/** The viewer's explicit choices, by column id: `true` shown, `false` hidden. Absent: the default. */
export type ColumnChoices = Readonly<Record<string, boolean>>;

/**
 * The columns on screen, in order: a locked column always; otherwise the viewer's choice, or the
 * column's default when they never made one. A choice for a column that no longer exists is
 * ignored, and a column added later starts at its own default — so stored choices never hide or
 * reveal anything they did not name.
 *
 * Never empty: if every column the viewer could hide is hidden and none is locked, the first one
 * stays (the chooser also refuses to uncheck the last visible column).
 */
export function visibleColumns<C extends Pick<GridColumnMeta, "id" | "locked" | "defaultHidden">>(
  columns: readonly C[],
  choices: ColumnChoices,
): C[] {
  const shown = columns.filter(
    (c) => c.locked || (Object.hasOwn(choices, c.id) ? choices[c.id] === true : !c.defaultHidden),
  );
  return shown.length > 0 || columns.length === 0 ? shown : [columns[0]!];
}

/**
 * The stored column choices, read defensively: localStorage is the viewer's to edit, so anything
 * that is not a plain object of booleans is ignored (the grid renders its defaults) rather than
 * trusted — a malformed value must never break a list page.
 */
export function parseColumnChoices(raw: string | null | undefined): ColumnChoices {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, boolean> = {};
  for (const [id, value] of Object.entries(parsed)) if (typeof value === "boolean") out[id] = value;
  return out;
}

/**
 * Each width's drawn size, ESTIMATED in rem with its cell padding (12px a side) — an upper bound
 * of the `ch` widths globals.css draws (Inter's figure is ~0.62em of the 13.5px table type). Used
 * for ONE thing: the table's minimum width, so a text column keeps a few readable characters
 * before the grid scrolls sideways instead. The drawn widths stay the stylesheet's; whether the
 * grid actually fits is MEASURED (`DataGridView`), never inferred from these.
 */
export const GRID_WIDTH_REM: Readonly<Record<GridColumnWidth, number>> = {
  fill: 4.5,
  id: 9.5,
  customer: 13.75,
  "typed-id": 16,
  status: 8.5,
  date: 8,
  number: 6,
  money: 9,
  short: 9,
  actions: 13.5,
};

/** A wrapping text column (a worker's message) keeps a reading width before the grid scrolls. */
export const GRID_WRAP_MIN_REM = 14;

/** The row link's end chevron column. */
export const GRID_END_REM = 2;

/** A cell's two inline paddings (`--grid-pad-inline`, 12px a side). */
export const GRID_CELL_PAD_REM = 1.5;

/** The widest glyph of each class at the header type, in rem (Chrome, Inter 700, 2026-11). */
const HEADER_GLYPH_REM = { narrow: 0.36, semi: 0.48, regular: 0.61, wide: 0.81 } as const;
const HEADER_NARROW = new Set(" .,·'()/I1");
const HEADER_SEMI = new Set("-LJFE7");
const HEADER_WIDE = new Set("MW");
const HEADER_SORT_REM = 1.25;

/**
 * A column header's label, as its width in rem — ESTIMATED from its characters, because the
 * header type is not the cells' (11.5px Inter Bold, uppercase, tracked 0.06em: `.table th`) and
 * the widths by kind are in the cells' `ch`. Each character counts as the WIDEST glyph of its
 * class, measured in Chrome with Inter: so the estimate never falls short of the drawn label (the
 * widest header is ~15% over), and a character outside the classes counts as wide. A sortable
 * header adds its arrow and the gap before it (16px + 4px).
 */
export function headerWidthRem(header: string, sortable = false): number {
  let rem = sortable ? HEADER_SORT_REM : 0;
  for (const glyph of header.toUpperCase()) {
    rem += HEADER_NARROW.has(glyph)
      ? HEADER_GLYPH_REM.narrow
      : HEADER_SEMI.has(glyph)
        ? HEADER_GLYPH_REM.semi
        : HEADER_WIDE.has(glyph) || !/[A-Z0-9&]/.test(glyph)
          ? HEADER_GLYPH_REM.wide
          : HEADER_GLYPH_REM.regular;
  }
  return Math.ceil(rem * 100) / 100;
}

/**
 * Whether a header can be CUT. A fixed kind is drawn at least as wide as its header (globals.css
 * takes the wider of the kind and `--col-head`), so never; a text column shares what is left and
 * can be squeezed to its minimum, where a header longer than that wraps and, past two lines, is
 * cut — so it carries its full label in a `title`.
 */
export function headerMayCut(column: Pick<GridColumnMeta, "width" | "header" | "sort">): boolean {
  return (
    column.width === "fill" &&
    headerWidthRem(column.header, column.sort !== undefined) > GRID_WIDTH_REM.fill - GRID_CELL_PAD_REM
  );
}

/** The minimum width, in rem, of a table drawing `columns` (and the chevron column when linked). */
export function gridMinWidthRem(
  columns: readonly Pick<GridColumnMeta, "width" | "text" | "header" | "sort">[],
  linked: boolean,
): number {
  const sum = columns.reduce((total, c) => total + columnMinRem(c), linked ? GRID_END_REM : 0);
  return Math.round(sum * 4) / 4;
}

/** One column's share of the minimum: its kind's width — or, for a fixed kind, its header's. */
function columnMinRem(c: Pick<GridColumnMeta, "width" | "text" | "header" | "sort">): number {
  if (c.width === "fill") return c.text === "wrap" ? GRID_WRAP_MIN_REM : GRID_WIDTH_REM.fill;
  return Math.max(GRID_WIDTH_REM[c.width], headerWidthRem(c.header, c.sort !== undefined) + GRID_CELL_PAD_REM);
}
