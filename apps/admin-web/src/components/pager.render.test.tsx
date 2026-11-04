import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NumberedPager, Pager } from "./pager";

/**
 * The keyset Pager's links re-render the same page with a new cursor — the query-only navigation
 * the console's no-boundary rule is about — so each carries the navigation pending cue
 * (components/nav-pending.tsx, delta review of #2095), which is also what shows the data grid's
 * pending state (A4, #2574). Since A4 a later page also offers the first one.
 */
const CUE = '<span class="nav-pending" aria-hidden="true"></span>';

describe("Pager (keyset)", () => {
  it("renders nothing on a first page that is also the last", () => {
    expect(
      renderToStaticMarkup(
        <Pager basePath="/workers" params={{}} cursor={undefined} nextCursor={null} />,
      ),
    ).toBe("");
  });

  it("its Next page link keeps the filters, carries the next cursor and the pending cue", () => {
    const out = renderToStaticMarkup(
      <Pager basePath="/workers" params={{ status: "active" }} cursor={undefined} nextCursor="c2" />,
    );
    expect(out).toContain('href="/workers?status=active&amp;cursor=c2"');
    expect(out).toMatch(
      /Next page<i class="ph-fill ph-caret-right" aria-hidden="true"><\/i><span class="nav-pending" aria-hidden="true"><\/span><\/a>/,
    );
    // On the first page there is nothing to go back to.
    expect(out).not.toContain("First page");
  });

  it("past page one: First page is the same query with no cursor — every filter kept", () => {
    const out = renderToStaticMarkup(
      <Pager basePath="/workers" params={{ status: "active" }} cursor="c2" nextCursor="c3" />,
    );
    expect(out).toMatch(
      new RegExp(
        `href="/workers\\?status=active"><i class="ph-fill ph-caret-double-left" aria-hidden="true"></i>First page${CUE}</a>`,
      ),
    );
    expect(out).toContain('href="/workers?status=active&amp;cursor=c3"');
    expect(out.indexOf("First page")).toBeLessThan(out.indexOf("Next page"));
  });

  it("on the last page past the first, only First page", () => {
    const out = renderToStaticMarkup(
      <Pager basePath="/events" params={{}} cursor="c9" nextCursor={null} />,
    );
    expect(out).toContain('href="/events"');
    expect(out).toContain("First page");
    expect(out).not.toContain("Next page");
  });

  it("never stacks cursors: a cursor in the params is not how the base is built", () => {
    const out = renderToStaticMarkup(
      <Pager basePath="/jobs" params={{ status: "open" }} cursor="c1" nextCursor="c2" />,
    );
    expect(out.match(/cursor=/g)).toHaveLength(1);
  });

  it("is a named navigation, its keyset note one click away behind an ⓘ", () => {
    const out = renderToStaticMarkup(
      <Pager basePath="/workers" params={{}} cursor={undefined} nextCursor="c2" note="Keyset note." />,
    );
    expect(out).toMatch(/^<nav class="pager" aria-label="Pages">/);
    expect(out).toContain('<summary class="infopop__toggle" aria-label="About paging"');
    expect(out).toContain("<p>Keyset note.</p>");
  });
});

describe("NumberedPager (an exact total)", () => {
  const render = (page: number, total = 24_310, params: Record<string, string | undefined> = {}) =>
    renderToStaticMarkup(
      <NumberedPager basePath="/candidates" params={params} page={page} pageSize={50} total={total} />,
    );

  it("reads '1–50 of 24,310 · ‹ 1 2 3 … 487 ›' on the first page", () => {
    const out = render(1);
    expect(out).toContain('<p class="pager__range">1–50 of 24,310</p>');
    expect(out).toContain('<span class="pager__sep" aria-hidden="true">·</span>');
    const slots = [...out.matchAll(/<li[^>]*>(?:<[^>]+>)*([^<]*)/g)].map((m) => m[1]);
    expect(slots).toContain("…");
    expect(out).toContain('<span class="pager__page" aria-current="page">1</span>');
    for (const n of [2, 3, 487]) {
      expect(out).toContain(`href="/candidates?page=${n}"`);
    }
  });

  it("previous is not a link on the first page, next is not one on the last", () => {
    const first = render(1);
    expect(first).toContain('<span class="pager__step" aria-disabled="true"><i class="ph-fill ph-caret-left"');
    expect(first).toContain('href="/candidates?page=2"><i class="ph-fill ph-caret-right"');
    const last = render(487);
    expect(last).toContain('<p class="pager__range">24,301–24,310 of 24,310</p>');
    expect(last).toContain('<span class="pager__step" aria-disabled="true"><i class="ph-fill ph-caret-right"');
  });

  it("page one is the bare query (no page=1); every link keeps the filters", () => {
    const out = render(2, 24_310, { status: "active", pageSize: "50" });
    expect(out).toContain('href="/candidates?status=active&amp;pageSize=50"');
    expect(out).toContain('href="/candidates?status=active&amp;pageSize=50&amp;page=3"');
  });

  it("names every control for assistive tech, and carries the cue on every link", () => {
    const out = render(10);
    expect(out).toContain('<span class="sr-only">Previous page</span>');
    expect(out).toContain('<span class="sr-only">Next page</span>');
    expect(out).toContain('<span class="sr-only">Page </span>9');
    const links = out.match(/<a /g) ?? [];
    expect((out.match(new RegExp(CUE, "g")) ?? []).length).toBe(links.length);
  });

  it("past the end it says so, and still leads back into the list", () => {
    const out = render(600);
    expect(out).toContain("No rows on this page · 24,310 in all");
    expect(out).toContain('href="/candidates?page=487"');
    expect(out).not.toContain('aria-current="page"');
  });

  it("draws nothing for an empty list — the page's empty state speaks instead", () => {
    expect(render(1, 0)).toBe("");
  });
});
