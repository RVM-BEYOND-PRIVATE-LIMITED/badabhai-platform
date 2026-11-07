import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * EVERY LIST ON THE ONE DATA GRID (A4, #2574). Read from source, where the claim is structural:
 * a list page that hand-rolls a `<table>` again loses the one scroller, the sticky header, the row
 * link, the pending state and the viewer's columns all at once, and nothing else would notice.
 */
const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..");
const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const code = (rel: string) => stripComments(readFileSync(join(src, rel), "utf8"));

/** Each list, and the module that draws its rows (the page itself, or its shared list component). */
const LISTS: Array<[list: string, rows: string]> = [
  ["app/(portal)/events/page.tsx", "components/event-table.tsx"],
  ["components/entity-timeline.tsx", "components/event-table.tsx"],
  ["app/(portal)/candidates/page.tsx", "app/(portal)/candidates/candidates-bank.tsx"],
  /* Every customer — Companies and Agencies are one list since A6 (#2576), with a Kind filter.
     A9 (#2579) moved Companies' rows onto the grid in the page itself. */
  ["app/(portal)/companies/page.tsx", "app/(portal)/companies/page.tsx"],
  ["app/(portal)/jobs/page.tsx", "app/(portal)/jobs/page.tsx"],
  ["app/(portal)/jobs/agency/page.tsx", "app/(portal)/jobs/agency/page.tsx"],
  ["app/(portal)/feedback/page.tsx", "app/(portal)/feedback/page.tsx"],
  ["app/(portal)/ai-calls/page.tsx", "app/(portal)/ai-calls/page.tsx"],
  ["app/(portal)/credits/page.tsx", "app/(portal)/credits/page.tsx"],
  ["app/(portal)/transactions/page.tsx", "app/(portal)/transactions/page.tsx"],
  ["app/(portal)/admins/page.tsx", "app/(portal)/admins/page.tsx"],
  ["app/(portal)/skills/discovery/page.tsx", "app/(portal)/skills/discovery/page.tsx"],
  [
    "app/(portal)/candidates/[id]/journey/page.tsx",
    "app/(portal)/candidates/[id]/journey/page.tsx",
  ],
];

/**
 * The pages whose list IS the page — they fill a tall window (`page--list`). The others stack
 * sections above or below their list (stats, summaries, the create forms, the funnel), so the page
 * itself scrolls there, as one.
 */
const FILL_PAGES = [
  "app/(portal)/events/page.tsx",
  "components/entity-timeline.tsx",
  "app/(portal)/candidates/page.tsx",
  "app/(portal)/companies/page.tsx",
  "app/(portal)/jobs/page.tsx",
  "app/(portal)/jobs/agency/page.tsx",
  "app/(portal)/feedback/page.tsx",
  "app/(portal)/ai-calls/page.tsx",
];

describe("every list draws its rows on the data grid", () => {
  it.each(LISTS)("%s", (list, rows) => {
    const drawn = code(rows);
    expect(drawn, rows).toContain("<DataGrid");
    for (const file of new Set([list, rows])) {
      // No hand-rolled table, and no `.tablewrap` (a capped scroller inside the page's own).
      expect(code(file), file).not.toMatch(/<table\b/);
      expect(code(file), file).not.toContain("tablewrap");
    }
  });

  it("the list pages are the ones that fill a tall window; the stacked pages scroll as one", () => {
    for (const [list] of LISTS) {
      const fills = /className="page page--list"/.test(code(list));
      expect(fills, list).toBe(FILL_PAGES.includes(list));
    }
  });

  it("every keyset pager passes the page's own cursor, so a later page offers the first", () => {
    const pagers = LISTS.flatMap(([list, rows]) => [...new Set([list, rows])]).flatMap((file) =>
      [...code(file).matchAll(/<Pager\b([\s\S]*?)\/>/g)].map((m) => [file, m[1]!] as const),
    );
    // Nine keyset lists after A9 (#2579) moved Companies onto numbered pages (Candidates uses
    // the numbered pager too, A7 #2577); every remaining keyset list still passes its own cursor.
    expect(pagers.length).toBeGreaterThanOrEqual(9);
    for (const [file, props] of pagers) expect(props, file).toMatch(/\bcursor=\{/);
  });
});

/** Every filter bar in the console. */
function filterBars(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/filter-bar\.tsx$/.test(e.name)) out.push(relative(src, p).replace(/\\/g, "/"));
    }
  })(src);
  return out;
}

describe("the filter bars (A4)", () => {
  it("finds them all", () => {
    expect(filterBars().sort()).toEqual([
      "app/(portal)/accounts/accounts-filter-bar.tsx",
      "app/(portal)/ai-calls/filter-bar.tsx",
      "app/(portal)/companies/company-filter-bar.tsx",
      "app/(portal)/events/filter-bar.tsx",
      "app/(portal)/jobs/filter-bar.tsx",
      "app/(portal)/skills/discovery/filter-bar.tsx",
      "components/payer-filter-bar.tsx",
    ]);
  });

  it("every placeholder is an example, and says so: it starts with 'e.g.'", () => {
    const placeholders = filterBars().flatMap((file) =>
      [...code(file).matchAll(/placeholder="([^"]*)"/g)].map((m) => [file, m[1]!] as const),
    );
    expect(placeholders.length).toBeGreaterThanOrEqual(8);
    for (const [file, text] of placeholders) expect(text, file).toMatch(/^e\.g\. \S/);
  });

  it("the event-name example is an event the spine can hold — typed as shown, it finds something", () => {
    // It read "e.g. worker.profile_confirmed", which no event is called: an operator who typed the
    // example got "No events match these filters". The registry is read as SOURCE (admin-web takes
    // no dependency on @badabhai/event-schema), like lib/list-filter-values.test.ts does.
    const example = /placeholder="e\.g\. ([^"]+)"/.exec(
      code("app/(portal)/events/filter-bar.tsx"),
    )?.[1];
    expect(example).toBeTruthy();
    const registry = readFileSync(
      join(src, "..", "..", "..", "packages", "event-schema", "src", "registry.ts"),
      "utf8",
    );
    expect(registry).toContain(`"${example}": {`);
  });

  it("the event name is a combobox: free text, suggesting the names the page read", () => {
    const events = code("app/(portal)/events/filter-bar.tsx");
    expect(events).toMatch(/list=\{eventNames\.length > 0 \? namesId : undefined\}/);
    expect(events).toMatch(/<datalist id=\{namesId\}>/);
  });

  it("a field with a fixed set of values is a select: the events' actor and subject types", () => {
    const events = code("app/(portal)/events/filter-bar.tsx");
    expect(events).toMatch(
      /value=\{values\.actorType\}[^>]*>\s*\{typeOptions\(values\.actorType, EVENT_ACTOR_TYPES\)\}/,
    );
    expect(events).toMatch(
      /value=\{values\.subjectType\}[^>]*>\s*\{typeOptions\(values\.subjectType, EVENT_SUBJECT_TYPES\)\}/,
    );
    expect(events).toMatch(/<select className="field__input" value=\{values\.actorType\}/);
    expect(events).toMatch(/<select className="field__input" value=\{values\.subjectType\}/);
  });
});
