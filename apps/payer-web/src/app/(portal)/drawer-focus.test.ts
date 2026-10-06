import { describe, expect, it, vi } from "vitest";
import { TOOLTIP_DISMISSED_ATTRIBUTE } from "@badabhai/icons";
import { drawerStops, openDrawer, type DrawerParts } from "./drawer-focus";

/**
 * The nav drawer's keyboard model (review of final sweep C). MEASURED BEFORE, Tab walk on
 * /dashboard at 375 and 900px: the closed drawer's 7 off-screen links were Tab stops 1–7, ahead of
 * the menu button; opening it from the keyboard left focus on the menu button, and 13 of 16 Tabs
 * then walked the page UNDER the open drawer; closing it with the scrim dropped focus to <body>.
 * (Hiding the closed drawer is CSS — shell-targets-contrast.css.test.ts.)
 *
 * Node env: the DOM is stand-ins. A stand-in element takes focus by becoming the document's
 * activeElement; `rects: 0` is an element with no box (`display: none`).
 */
function world({ modal = true } = {}) {
  const listeners = new Set<(e: KeyboardEvent) => void>();
  const doc = {
    activeElement: null as Element | null,
    body: { name: "body" } as unknown as Element,
    addEventListener: (_t: "keydown", fn: (e: KeyboardEvent) => void) => void listeners.add(fn),
    removeEventListener: (_t: "keydown", fn: (e: KeyboardEvent) => void) =>
      void listeners.delete(fn),
  };
  const el = (name: string, rects = 1) => {
    const e = {
      name,
      attrs: new Set<string>(),
      children: [] as { classList: { contains: (c: string) => boolean } }[],
      getClientRects: () => ({ length: rects }),
      setAttribute: (k: string) => void e.attrs.add(k),
      focus: () => {
        if (rects > 0) doc.activeElement = e as unknown as Element;
      },
    };
    return e;
  };
  const brand = el("brand");
  const dashboard = el("dashboard");
  const postings = el("postings");
  const collapse = el("collapse", 0); // display:none below 1280px
  const scrim = el("scrim");
  const header = el("header-link");
  const menu = el("menu");
  menu.children.push({ classList: { contains: (c: string) => c === "bb-icon-tip" } });
  const inRail = [brand, dashboard, postings, collapse];
  const close = vi.fn();
  const parts: DrawerParts = {
    doc,
    rail: {
      querySelectorAll: (() => inRail) as unknown as DrawerParts["rail"]["querySelectorAll"],
      contains: (n: Node | null) => inRail.some((x) => (x as unknown) === n),
    },
    scrim: scrim as unknown as HTMLElement,
    menu: () => menu as unknown as HTMLElement,
    isModal: () => modal,
    close,
  };
  const press = (key: string, shiftKey = false) => {
    const e = {
      key,
      shiftKey,
      defaultPrevented: false,
      preventDefault: () => (e.defaultPrevented = true),
    };
    for (const fn of listeners) fn(e as unknown as KeyboardEvent);
    return e;
  };
  const focused = () => (doc.activeElement as unknown as { name: string } | null)?.name ?? null;
  return { doc, parts, press, focused, listeners, close, brand, postings, scrim, header, menu };
}

describe("drawerStops — the drawer's Tab stops", () => {
  it("its drawn focusables in order, then the scrim; a display:none control is not a stop", () => {
    const w = world();
    const names = drawerStops(w.parts.rail, w.parts.scrim).map(
      (s) => (s as unknown as { name: string }).name,
    );
    expect(names).toEqual(["brand", "dashboard", "postings", "scrim"]);
  });
});

describe("openDrawer — open: focus moves in and Tab stays inside", () => {
  it("opening moves focus to the first stop", () => {
    const w = world();
    w.doc.activeElement = w.menu as unknown as Element;
    openDrawer(w.parts);
    expect(w.focused()).toBe("brand");
  });

  it("Tab on the last stop wraps to the first; Shift+Tab on the first wraps to the last", () => {
    const w = world();
    openDrawer(w.parts);
    w.scrim.focus();
    expect(w.press("Tab").defaultPrevented).toBe(true);
    expect(w.focused()).toBe("brand");
    expect(w.press("Tab", true).defaultPrevented).toBe(true);
    expect(w.focused()).toBe("scrim");
  });

  it("Tab between two inner stops is the browser's own (not intercepted)", () => {
    const w = world();
    openDrawer(w.parts);
    w.postings.focus();
    expect(w.press("Tab").defaultPrevented).toBe(false);
    expect(w.press("Tab", true).defaultPrevented).toBe(false);
    expect(w.focused()).toBe("postings");
  });

  it("focus that is somehow outside is pulled back in on the next Tab", () => {
    const w = world();
    openDrawer(w.parts);
    w.header.focus();
    expect(w.press("Tab").defaultPrevented).toBe(true);
    expect(w.focused()).toBe("brand");
  });

  it("Escape closes it", () => {
    const w = world();
    openDrawer(w.parts);
    w.press("Escape");
    expect(w.close).toHaveBeenCalledTimes(1);
  });

  it("not an overlay (≥1024px): focus is not moved and Tab is not contained; Escape still closes", () => {
    const w = world({ modal: false });
    w.doc.activeElement = w.menu as unknown as Element;
    openDrawer(w.parts);
    expect(w.focused()).toBe("menu");
    w.scrim.focus();
    expect(w.press("Tab").defaultPrevented).toBe(false);
    w.press("Escape");
    expect(w.close).toHaveBeenCalledTimes(1);
  });
});

describe("openDrawer — closing: focus goes back to the menu button", () => {
  it.each(["postings", "scrim", "body"] as const)(
    "focus on %s (in the drawer, or lost with it) returns to the menu with its tooltip closed",
    (where) => {
      const w = world();
      const disarm = openDrawer(w.parts);
      if (where === "postings") w.postings.focus();
      if (where === "scrim") w.scrim.focus();
      if (where === "body") w.doc.activeElement = w.doc.body;
      disarm();
      expect(w.focused()).toBe("menu");
      expect(w.menu.attrs.has(TOOLTIP_DISMISSED_ATTRIBUTE)).toBe(true);
    },
  );

  it("focus the user already moved elsewhere is left where it is", () => {
    const w = world();
    const disarm = openDrawer(w.parts);
    w.header.focus();
    disarm();
    expect(w.focused()).toBe("header-link");
  });

  it("the keydown listener is removed (Escape no longer closes; Tab no longer wraps)", () => {
    const w = world();
    const disarm = openDrawer(w.parts);
    expect(w.listeners.size).toBe(1);
    disarm();
    expect(w.listeners.size).toBe(0);
    w.press("Escape");
    expect(w.close).not.toHaveBeenCalled();
  });

  it("an unmounted menu button (null) is not an error", () => {
    const w = world();
    const disarm = openDrawer({ ...w.parts, menu: () => null });
    expect(() => disarm()).not.toThrow();
  });
});
