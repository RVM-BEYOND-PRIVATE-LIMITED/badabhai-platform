import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FilterPanel } from "./filter-panel";

/**
 * A list page's filter panel, folded behind one "Filters (n)" toggle on a phone (final sweep
 * AW-08): at 375px the panels stood 163-418px tall between the header and the first row. The
 * toggle exists only on a phone (CSS — page-height.css.test.ts); above it the panel is simply
 * open, exactly as before.
 */
const render = (activeCount: number) =>
  renderToStaticMarkup(
    <FilterPanel headingId="wf-heading" heading="Filter workers" activeCount={activeCount}>
      <form className="filters" />
    </FilterPanel>,
  );

/** The toggle's opening tag. */
const toggleTag = (out: string) => {
  const at = out.indexOf("filter-panel__toggle");
  expect(at).toBeGreaterThanOrEqual(0);
  return out.slice(out.lastIndexOf("<button", at), out.indexOf(">", at) + 1);
};

describe("FilterPanel", () => {
  it("keeps the panel's named section and its filters", () => {
    const out = render(0);
    expect(out).toContain('aria-labelledby="wf-heading"');
    expect(out).toContain('<h2 class="sr-only" id="wf-heading">Filter workers</h2>');
    expect(out).toContain('<form class="filters"></form>');
  });

  it("starts CLOSED when no filter is set — the phone shows only the toggle", () => {
    const out = render(0);
    expect(out).toContain('data-open="false"');
    expect(toggleTag(out)).toContain('aria-expanded="false"');
    expect(out).toContain(">Filters</button>");
  });

  it("starts OPEN when a filter is set, and says how many", () => {
    const out = render(2);
    expect(out).toContain('data-open="true"');
    expect(toggleTag(out)).toContain('aria-expanded="true"');
    expect(out).toContain(">Filters (2)</button>");
  });

  it("the toggle is a real button that names the fields it controls", () => {
    const out = render(1);
    const tag = toggleTag(out);
    expect(tag).toContain('type="button"');
    const controls = /aria-controls="([^"]+)"/.exec(tag)?.[1];
    expect(controls).toBeTruthy();
    expect(out).toContain(`<div class="filter-panel__body" id="${controls}">`);
  });

  it("draws the brand disclosure caret, like every other disclosure in the console", () => {
    const out = render(0);
    const start = out.lastIndexOf("<button", out.indexOf("filter-panel__toggle"));
    const button = out.slice(start, out.indexOf("</button>", start));
    expect(button).toContain("disclosure__caret");
  });
});
