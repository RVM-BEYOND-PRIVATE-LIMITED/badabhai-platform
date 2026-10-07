import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FilterPanel, filterSetKey } from "./filter-panel";

/**
 * A list page's filter panel, folded behind one "Filters (n)" toggle on a phone (final sweep
 * AW-08): at 375px the panels stood 163-418px tall between a list's header and its first row. The
 * toggle exists only on a phone (CSS — page-height.css.test.ts); above it the panel is simply
 * open, exactly as before.
 */
const render = (filters: Record<string, string | boolean | undefined>) =>
  renderToStaticMarkup(
    <FilterPanel headingId="wf-heading" heading="Filter workers" filters={filters}>
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
    const out = render({});
    expect(out).toContain('aria-labelledby="wf-heading"');
    expect(out).toContain('<h2 class="sr-only" id="wf-heading">Filter workers</h2>');
    expect(out).toContain('<form class="filters"></form>');
  });

  it("starts CLOSED when no filter is set — the phone shows only the toggle", () => {
    const out = render({ status: undefined, pendingDeletion: false });
    expect(out).toContain('data-open="false"');
    expect(toggleTag(out)).toContain('aria-expanded="false"');
    expect(out).toContain(">Filters</button>");
  });

  it("starts OPEN when a filter is set, and says how many", () => {
    const out = render({ status: "active", pendingDeletion: true, cursorless: "" });
    expect(out).toContain('data-open="true"');
    expect(toggleTag(out)).toContain('aria-expanded="true"');
    expect(out).toContain(">Filters (2)</button>");
  });

  it("the toggle is a real button that names the fields it controls", () => {
    const out = render({ status: "active" });
    const tag = toggleTag(out);
    expect(tag).toContain('type="button"');
    const controls = /aria-controls="([^"]+)"/.exec(tag)?.[1];
    expect(controls).toBeTruthy();
    expect(out).toContain(`<div class="filter-panel__body" id="${controls}">`);
  });

  it("draws the brand disclosure caret, like every other disclosure in the console", () => {
    const out = render({});
    const start = out.lastIndexOf("<button", out.indexOf("filter-panel__toggle"));
    const button = out.slice(start, out.indexOf("</button>", start));
    expect(button).toContain("disclosure__caret");
  });
});

/**
 * The filter set's identity — what the panel re-syncs its open state on (the re-sync itself is
 * driven render by render in url-state.behaviour.test.tsx). Review Nit-1: it was a `name=value`
 * join, so a value holding `&` or `=` could pass for another set; it is JSON now.
 */
describe("filterSetKey", () => {
  it("names the SET filters only — empty, false and absent are not set", () => {
    expect(
      filterSetKey({ status: "active", pendingDeletion: false, cursorless: "", x: undefined }),
    ).toBe(filterSetKey({ status: "active" }));
  });

  it("a value holding & or = cannot pass for another filter set", () => {
    expect(filterSetKey({ eventName: "a&actorType=b" })).not.toBe(
      filterSetKey({ eventName: "a", actorType: "b" }),
    );
    expect(filterSetKey({ eventName: "a=b" })).not.toBe(filterSetKey({ "eventName=a": "b" }));
  });

  it("a different value is a different set; the same values are the same set", () => {
    expect(filterSetKey({ correlationId: "a" })).not.toBe(filterSetKey({ correlationId: "b" }));
    expect(filterSetKey({ status: "active", payerId: "p" })).toBe(
      filterSetKey({ status: "active", payerId: "p" }),
    );
  });
});
