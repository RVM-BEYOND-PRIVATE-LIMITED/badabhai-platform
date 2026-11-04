import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ReactModule from "react";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GridColumn } from "./data-grid";

/**
 * THE DATA GRID's contract (A4, #2574) — what a list page gets by declaring columns, and what the
 * Candidates (#2577), User accounts (#2578) and Companies (#2579) tabs build on: column
 * definitions with width kinds, the row as one stretched link with an end chevron, a sticky
 * header, a pager slot, the pending state, and the viewer's column chooser and density.
 *
 * The node env has no reconciler: `useSyncExternalStore` reads the CLIENT snapshot here (what the
 * browser shows once hydrated), so the real stores — the navigation store and the viewer's
 * preferences — drive each render.
 */
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof ReactModule>()),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));

const { DataGrid, gridColumnMeta } = await import("./data-grid");
const { DataGridView } = await import("./data-grid-view");
const { NumberedPager, Pager } = await import("./pager");
const { announceNavigation, resetNavigationForTests, withdrawNavigation } = await import(
  "./nav-pending-store"
);
const { resetGridPreferencesForTests, writeColumnChoices, writeDensity } = await import(
  "./grid-preferences"
);


interface Row {
  id: string;
  name: string | null;
  status: string;
  city: string;
}

const ROWS: Row[] = [
  { id: "5eeded00-0001-4a00-8000-000000000001", name: "Ramesh Kumar", status: "active", city: "Pune" },
  { id: "5eeded00-0002-4a00-8000-000000000002", name: null, status: "pending", city: "Chakan MIDC" },
];

const COLUMNS: GridColumn<Row>[] = [
  { id: "name", header: "Name", cell: (r) => r.name ?? "—", title: (r) => r.name ?? undefined },
  {
    id: "id",
    header: "Worker",
    width: "id",
    cell: (r) => <span className="mono">{r.id.slice(0, 4)}</span>,
    trail: (r) => <button type="button">copy {r.id.slice(0, 4)}</button>,
  },
  { id: "status", header: "Status", width: "status", cell: (r) => r.status },
  { id: "city", header: "City", cell: (r) => r.city, title: (r) => r.city, className: "table__meta" },
];

const LINK = {
  column: "name",
  href: (r: Row) => `/workers/${r.id}`,
  name: (r: Row) => r.name ?? `worker ${r.id.slice(0, 4)}`,
  label: (r: Row) => (r.name ? undefined : `Worker ${r.id.slice(0, 4)}, no name on record`),
};

const grid = (over: Partial<Parameters<typeof DataGrid<Row>>[0]> = {}) =>
  renderToStaticMarkup(
    <DataGrid<Row>
      id="test-grid"
      caption="Workers, newest first"
      columns={COLUMNS}
      rows={ROWS}
      rowKey={(r) => r.id}
      rowLink={LINK}
      {...over}
    />,
  );

/** The body rows' markup, one string per row. */
const bodyRows = (html: string) =>
  html
    .slice(html.indexOf("<tbody>") + 7, html.indexOf("</tbody>"))
    .split("</tr>")
    .filter(Boolean);
/** The column headers' text, in order. */
const headers = (html: string) => [...html.matchAll(/<th scope="col"[^>]*>([^<]*)/g)].map((m) => m[1]);

beforeEach(() => {
  resetNavigationForTests();
  resetGridPreferencesForTests();
});

describe("columns", () => {
  it("draws one plain column header per column, in order, and names the table for assistive tech", () => {
    const out = grid();
    expect(headers(out)).toEqual(["Name", "Worker", "Status", "City"]);
    expect(out).toContain('<th scope="col">Status</th>');
    expect(out).toContain('<caption class="sr-only">Workers, newest first</caption>');
  });

  it("sizes each column by its KIND — the stylesheet holds the widths, a page never a size", () => {
    const out = grid();
    const cols = [...out.matchAll(/<col class="([^"]*)"/g)].map((m) => m[1]);
    expect(cols).toEqual([
      "grid__col grid__col--fill",
      "grid__col grid__col--id",
      "grid__col grid__col--status",
      "grid__col grid__col--fill",
      "grid__col grid__col--end",
    ]);
  });

  it("a text column cuts with an ellipsis and keeps the whole value in its title", () => {
    const out = grid({ rowLink: undefined });
    expect(out).toContain('<td class="grid__cell--truncate table__meta" title="Chakan MIDC">Chakan MIDC</td>');
  });

  it("is a sticky-header table on the console's table styles, never narrower than its columns", () => {
    const out = grid();
    expect(out).toContain('<table class="table grid__table" style="--grid-min:');
    expect(out).toContain('<div class="grid__scroll">');
    expect(out).toContain('<tr class="grid__progress-row" aria-hidden="true">');
  });

  it("evaluates every cell on the server and hands the client view plain data — no functions", () => {
    const el = DataGrid<Row>({
      id: "test-grid",
      caption: "c",
      columns: COLUMNS,
      rows: ROWS,
      rowKey: (r) => r.id,
      rowLink: LINK,
    }) as ReactElement<Record<string, unknown>>;
    expect(el.type).toBe(DataGridView);
    const fns: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (typeof value === "function") fns.push(path);
      else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
      else if (value && typeof value === "object" && !isValidElement(value))
        for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
    };
    walk(el.props.columns, "columns");
    walk(el.props.rows, "rows");
    expect(fns).toEqual([]);
  });
});

describe("the row as ONE link", () => {
  it("the name cell is the row's link — one per row, its page, the name as its text", () => {
    const out = grid();
    const rows = bodyRows(out);
    expect(rows).toHaveLength(2);
    for (const [i, row] of rows.entries()) {
      expect(row.split('class="grid__link"')).toHaveLength(2);
      expect(row).toContain(`href="/workers/${ROWS[i]!.id}"`);
    }
    expect(rows[0]).toMatch(
      /<td class="grid__cell--truncate grid__cell--link"><a class="grid__link" href="\/workers\/[^"]+"><span class="grid__link-text" title="Ramesh Kumar">Ramesh Kumar<\/span>/,
    );
  });

  it("gives a row whose visible name says nothing a link name that does", () => {
    const [, nameless] = bodyRows(grid());
    expect(nameless).toContain('aria-label="Worker 5eed, no name on record"');
    expect(bodyRows(grid())[0]).not.toContain("aria-label=");
  });

  it("ends each linked row with a chevron — decoration, hidden from assistive tech", () => {
    const out = grid();
    for (const row of bodyRows(out)) {
      expect(row).toMatch(
        /<td class="grid__end" aria-hidden="true"><i class="ph-fill ph-caret-right" aria-hidden="true"><\/i><\/td>$/,
      );
    }
    expect(out).toContain('<th class="grid__end" aria-hidden="true"></th>');
  });

  it("a trail sits OUTSIDE the link — a button inside a link is invalid markup", () => {
    const out = grid({ rowLink: { ...LINK, column: "id" } });
    const [row] = bodyRows(out);
    expect(row).toMatch(/<\/a><button type="button">copy 5eed<\/button><\/td>/);
  });

  it("carries the navigation cue, so opening a row shows the grid's pending state", () => {
    const [row] = bodyRows(grid());
    expect(row).toContain('<span class="nav-pending" aria-hidden="true"></span></a>');
    const el = DataGrid<Row>({
      id: "g",
      caption: "c",
      columns: COLUMNS,
      rows: ROWS,
      rowKey: (r) => r.id,
      rowLink: LINK,
    }) as ReactElement<{ rows: { name?: string; href?: string }[] }>;
    expect(el.props.rows.map((r) => r.name)).toEqual(["Ramesh Kumar", "worker 5eed"]);
  });

  it("the link's column can never be hidden; without a row link nothing links and no chevron is drawn", () => {
    writeColumnChoices("test-grid", { name: false });
    expect(headers(grid())).toContain("Name");
    const plain = grid({ rowLink: undefined });
    expect(plain).not.toContain("grid__link");
    expect(plain).not.toContain("grid__end");
    expect(plain).not.toContain("grid__col--end");
  });
});

describe("the viewer's column choices (their own browser)", () => {
  it("a hidden column is not drawn at all — header and rows stay the same width", () => {
    writeColumnChoices("test-grid", { city: false });
    const out = grid();
    expect(headers(out)).toEqual(["Name", "Worker", "Status"]);
    for (const row of bodyRows(out)) {
      expect(row.split("<td").length - 1).toBe(3 + 1); // three data cells and the chevron
      expect(row).not.toContain("Pune");
    }
  });

  it("a column hidden by default shows only once chosen", () => {
    const columns = COLUMNS.map((c) => (c.id === "city" ? { ...c, defaultHidden: true } : c));
    expect(headers(grid({ columns }))).not.toContain("City");
    writeColumnChoices("test-grid", { city: true });
    expect(headers(grid({ columns }))).toContain("City");
  });

  it("choices are per grid", () => {
    writeColumnChoices("another-grid", { city: false });
    expect(headers(grid())).toContain("City");
  });

  it("the table's minimum width follows the columns on screen", () => {
    const min = (html: string) => Number(/--grid-min:([\d.]+)rem/.exec(html)?.[1]);
    const all = min(grid());
    writeColumnChoices("test-grid", { status: false });
    expect(min(grid())).toBeLessThan(all);
  });
});

describe("density (44px / 36px rows)", () => {
  it("is comfortable until the viewer chooses compact", () => {
    expect(grid()).toContain('data-density="comfortable"');
    writeDensity("compact");
    expect(grid()).toContain('data-density="compact"');
  });
});

describe("the pending state — a navigation under way, after the console's delay", () => {
  it("idle: the table is not busy", () => {
    expect(grid()).not.toContain("aria-busy");
  });

  it("once the navigation store announces (180ms in), the table is aria-busy", () => {
    const token = announceNavigation("Applying the filters…");
    expect(grid()).toContain('<table class="table grid__table" aria-busy="true"');
    withdrawNavigation(token);
    expect(grid()).not.toContain("aria-busy");
  });
});

describe("the footer bar", () => {
  it("holds the pager slot and the view controls", () => {
    const out = grid({
      pager: <Pager basePath="/workers" params={{}} cursor={undefined} nextCursor="c2" />,
    });
    const footer = out.slice(out.indexOf('<div class="grid__footer">'));
    expect(footer).toContain('<div class="grid__pager"><nav class="pager" aria-label="Pages">');
    expect(footer).toContain('<div class="grid__controls">');
    expect(footer).toContain(">Compact rows</button>");
    expect(footer).toContain("Columns</button>");
  });

  it("takes the numbered pager in the same slot, for a list with an exact total", () => {
    const out = grid({
      pager: <NumberedPager basePath="/candidates" params={{}} page={1} pageSize={50} total={24_310} />,
    });
    expect(out).toContain("1–50 of 24,310");
  });

  it("without view controls or a pager there is no footer bar (a dashboard panel)", () => {
    const out = grid({ viewControls: false });
    expect(out).not.toContain("grid__footer");
    expect(out).not.toContain("Compact rows");
  });
});

describe("a sortable header", () => {
  const sorted = (direction?: "ascending" | "descending") =>
    grid({
      columns: COLUMNS.map((c) =>
        c.id === "status"
          ? { ...c, sort: { href: "/workers?sort=status", direction, label: "sort by status" } }
          : c,
      ),
    });

  it("is a link to the list ordered by it, telling assistive tech the current order", () => {
    const out = sorted("descending");
    expect(out).toMatch(
      /<th scope="col" aria-sort="descending"><a class="grid__sort" data-direction="descending" href="\/workers\?sort=status">Status<span class="sr-only">, sort by status<\/span><i class="ph-fill ph-sort-descending grid__sort-icon" aria-hidden="true"><\/i>/,
    );
  });

  it("a column that does not sort the list says so too — no aria-sort, its arrow at rest", () => {
    const out = sorted(undefined);
    expect(out).toContain('<th scope="col"><a class="grid__sort" data-direction="none"');
  });
});

describe("a row-header column", () => {
  it("labels its row (`th scope=row`, the console's row-header hook), even as the row's link", () => {
    const columns = COLUMNS.map((c) => (c.id === "name" ? { ...c, rowHeader: true } : c));
    const [row] = bodyRows(grid({ columns }));
    expect(row).toMatch(/^<tr><th class="table__rowhead grid__cell--truncate grid__cell--link" scope="row">/);
  });
});

describe("gridColumnMeta — a page's columns as the client view takes them", () => {
  it("makes every default explicit and locks the link's column", () => {
    const meta = gridColumnMeta(COLUMNS, "name");
    expect(meta.find((c) => c.id === "name")).toMatchObject({ locked: true, text: "truncate", width: "fill" });
    expect(meta.find((c) => c.id === "id")).toMatchObject({ locked: false, width: "id" });
    expect(meta.find((c) => c.id === "id")?.text).toBeUndefined();
  });
});
