import { afterEach, describe, expect, it, vi } from "vitest";
import type { MouseEvent, ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PortalLink } from "./portal-link";
import { focusIfPagedHere, PagedListHeading, PagerLink } from "./paged-list";
import { requestListFocus, takeListFocus } from "../lib/list-focus";

/**
 * #2588 — paging moves focus to the heading of the list it opens. Node env: the heading's ref and
 * the link's click handler are driven with stand-ins (a window location, one animation frame, an
 * element that records `focus`).
 */

afterEach(() => {
  vi.unstubAllGlobals();
  // Leave no request behind for the next case.
  takeListFocus("/candidates?cursor=abc&from=21");
});

/** The page the browser is on, and the frames scheduled since. */
function onPage(address: string) {
  const url = new URL(address, "http://portal.invalid");
  const frames: Array<() => void> = [];
  vi.stubGlobal("window", { location: { pathname: url.pathname, search: url.search } });
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => frames.push(cb));
  return frames;
}
const heading = (isConnected = true) =>
  ({ isConnected, focus: vi.fn() }) as unknown as HTMLHeadingElement & {
    focus: ReturnType<typeof vi.fn>;
  };

describe("PagedListHeading — the list's h2, focusable by script only", () => {
  it("renders an h2 with tabindex=-1 (never a tab stop) and the caller's class", () => {
    expect(
      renderToStaticMarkup(
        <PagedListHeading className="candidate-search__count">57 candidates</PagedListHeading>,
      ),
    ).toBe(
      '<h2 tabindex="-1" class="paged-list-heading candidate-search__count">57 candidates</h2>',
    );
    expect(renderToStaticMarkup(<PagedListHeading>Showing 21–40</PagedListHeading>)).toBe(
      '<h2 tabindex="-1" class="paged-list-heading">Showing 21–40</h2>',
    );
  });

  it("is hook-free: its work is the ref, so a plain call returns the element", () => {
    const el = PagedListHeading({ children: "x" }) as ReactElement<{ ref?: unknown }>;
    expect(el.type).toBe("h2");
    expect(el.props.ref).toBe(focusIfPagedHere);
  });
});

describe("focusIfPagedHere — the heading takes focus on the address a pager link asked for", () => {
  it("asked for THIS address: focus moves one frame later (after the router's scroll)", () => {
    const frames = onPage("/candidates?cursor=abc&from=21");
    requestListFocus("/candidates?cursor=abc&from=21");
    const h = heading();
    focusIfPagedHere(h);
    expect(h.focus).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    frames[0]!();
    expect(h.focus).toHaveBeenCalledTimes(1);
    // Once: the next attach (a re-render, StrictMode's second pass) does nothing.
    focusIfPagedHere(h);
    expect(frames).toHaveLength(1);
  });

  it("nothing asked (a plain visit, a reload, Back): focus stays where it is", () => {
    const frames = onPage("/candidates?cursor=abc&from=21");
    const h = heading();
    focusIfPagedHere(h);
    expect(frames).toEqual([]);
    expect(h.focus).not.toHaveBeenCalled();
  });

  it("asked for ANOTHER address (the list being left re-renders): no move, the request is kept", () => {
    const frames = onPage("/candidates");
    requestListFocus("/candidates?cursor=abc&from=21");
    focusIfPagedHere(heading());
    expect(frames).toEqual([]);
    expect(takeListFocus("/candidates?cursor=abc&from=21")).toBe(true);
  });

  it("a heading gone before its frame is not focused; a detach (null) is a no-op", () => {
    const frames = onPage("/candidates?cursor=abc&from=21");
    requestListFocus("/candidates?cursor=abc&from=21");
    const h = heading(false);
    focusIfPagedHere(h);
    frames[0]!();
    expect(h.focus).not.toHaveBeenCalled();
    expect(() => focusIfPagedHere(null)).not.toThrow();
  });
});

describe("PagerLink — a PortalLink whose plain click asks for the move", () => {
  const HREF = "/candidates?cursor=abc&from=21";
  const link = (onClick?: (e: MouseEvent<HTMLAnchorElement>) => void) =>
    PagerLink({
      href: HREF,
      pendingLabel: "Next page",
      className: "bb-btn bb-btn--secondary",
      onClick,
      children: "Next page",
    }) as ReactElement<Record<string, unknown>>;
  const click = (over: Partial<MouseEvent<HTMLAnchorElement>> = {}) =>
    ({
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      ...over,
    }) as MouseEvent<HTMLAnchorElement>;

  it("is the portal's link, with its pending cue and every prop it was given", () => {
    const el = link();
    expect(el.type).toBe(PortalLink);
    expect(el.props).toMatchObject({
      href: HREF,
      pendingLabel: "Next page",
      className: "bb-btn bb-btn--secondary",
    });
  });

  it("a plain click asks for focus on the address it opens; the caller's handler still runs", () => {
    const own = vi.fn();
    (link(own).props.onClick as (e: MouseEvent<HTMLAnchorElement>) => void)(click());
    expect(own).toHaveBeenCalledTimes(1);
    expect(takeListFocus(HREF)).toBe(true);
  });

  it("a click that does not navigate this tab asks for nothing (new tab/window, a prevented click)", () => {
    for (const over of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
      { defaultPrevented: true },
    ]) {
      (link().props.onClick as (e: MouseEvent<HTMLAnchorElement>) => void)(click(over));
      expect(takeListFocus(HREF), JSON.stringify(over)).toBe(false);
    }
  });
});
