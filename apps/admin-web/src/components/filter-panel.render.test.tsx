import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FilterPanel, rememberFocus, resumeFocus } from "./filter-panel";

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
 * REVIEW M1 — the open state was decided once, at mount, and Next keeps a client component's
 * state across a search-params-only navigation. So on a phone, /events (no filter, panel closed)
 * → a row's correlation-id link → /events?correlationId=… left the panel CLOSED over a filtered
 * list, and the filter bar inside kept its own stale state: an empty Correlation id that Apply
 * then dropped. The panel is now KEYED on the filter values it was given: a new filter set is a
 * new panel (open when non-empty), and the bar inside it re-reads the URL.
 *
 * The node env has no reconciler to re-render in, so these pin React's own contract: a different
 * `key` is a fresh mount, and a fresh mount reads `filters` again.
 */
describe("a new filter set is a new panel (review M1)", () => {
  const panel = (filters: Record<string, string | boolean | undefined>) =>
    FilterPanel({
      headingId: "h",
      heading: "Filter events",
      filters,
      children: null,
    }) as ReactElement;

  it("0 → 1 active filter: a different key, so the panel remounts — and the new mount is open", () => {
    const none = panel({ correlationId: undefined, eventName: undefined });
    const one = panel({ correlationId: "5eeded00-00c0", eventName: undefined });
    expect(one.key).not.toBe(none.key);
    expect(renderToStaticMarkup(one)).toContain('data-open="true"');
  });

  it("a changed VALUE remounts too, so the bar shows the value the link carried (same count)", () => {
    expect(panel({ correlationId: "a" }).key).not.toBe(panel({ correlationId: "b" }).key);
  });

  it("the same filters keep the same panel — paging (a cursor is not a filter) remounts nothing", () => {
    expect(panel({ status: "active", pendingDeletion: false }).key).toBe(
      panel({ status: "active", pendingDeletion: false }).key,
    );
    expect(panel({ status: "", pendingDeletion: false }).key).toBe(panel({}).key);
  });
});

/**
 * The remount must not cost a keyboard user their place: before it, pressing Apply left focus on
 * Apply; a remount would drop it to <body>. So the panel remembers where focus was when ITS OWN
 * form was submitted, and the panel that mounts for the new filters puts it back.
 */
describe("focus survives the panel's own Apply", () => {
  type Ctl = {
    tabIndex: number;
    focus: ReturnType<typeof vi.fn>;
    getClientRects: () => { length: number };
  };
  const ctl = (): Ctl => ({ tabIndex: 0, focus: vi.fn(), getClientRects: () => ({ length: 1 }) });
  const section = (controls: Ctl[]) => ({ querySelectorAll: () => controls });
  const BODY = { body: true };

  it("remembers the submitting control's position in the panel", () => {
    const [toggle, field, apply] = [ctl(), ctl(), ctl()];
    expect(rememberFocus(section([toggle, field, apply]), apply, 1000)).toEqual({
      index: 2,
      at: 1000,
    });
    expect(rememberFocus(section([toggle, field, apply]), field, 1000)).toEqual({
      index: 1,
      at: 1000,
    });
  });

  it("remembers nothing when focus is not in the panel (Safari does not focus a clicked button)", () => {
    expect(rememberFocus(section([ctl()]), BODY, 1000)).toBeNull();
  });

  it("the remounted panel puts focus back on the control at the same position", () => {
    const [toggle, field, apply] = [ctl(), ctl(), ctl()];
    resumeFocus({ index: 2, at: 1000 }, section([toggle, field, apply]), {
      active: BODY,
      body: BODY,
      now: 1500,
    });
    expect(apply.focus).toHaveBeenCalledTimes(1);
    expect(field.focus).not.toHaveBeenCalled();
  });

  it("never takes focus from somewhere the operator put it", () => {
    const apply = ctl();
    const elsewhere = { link: true };
    resumeFocus({ index: 0, at: 1000 }, section([apply]), {
      active: elsewhere,
      body: BODY,
      now: 1500,
    });
    expect(apply.focus).not.toHaveBeenCalled();
  });

  it("ignores a stale memory — a remount long after the submit is someone else's navigation", () => {
    const apply = ctl();
    resumeFocus({ index: 0, at: 1000 }, section([apply]), {
      active: BODY,
      body: BODY,
      now: 1000 + 60_000,
    });
    expect(apply.focus).not.toHaveBeenCalled();
  });

  it("with nothing remembered, does nothing (an ordinary first mount)", () => {
    const apply = ctl();
    resumeFocus(null, section([apply]), { active: BODY, body: BODY, now: 1500 });
    expect(apply.focus).not.toHaveBeenCalled();
  });
});
