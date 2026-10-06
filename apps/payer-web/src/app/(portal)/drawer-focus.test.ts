import { describe, expect, it, vi } from "vitest";
import { TOOLTIP_DISMISSED_ATTRIBUTE } from "@badabhai/icons";
import { drawerStops, openDrawer, type DrawerParts } from "./drawer-focus";

/**
 * The nav drawer's keyboard model (review of final sweep C). MEASURED BEFORE, Tab walk on
 * /dashboard at 375 and 900px: the closed drawer's 7 off-screen links were Tab stops 1–7, ahead of
 * the menu button; opening it from the keyboard left focus on the menu button, and 13 of 16 Tabs
 * then walked the page UNDER the open drawer; closing it with the scrim dropped focus to <body>.
 * Second review: a link to the page already open (the brand, "Dashboard" on /dashboard) left the
 * drawer open, and widening past 1024px with it open left focus headed for a hidden menu button.
 * (Hiding the closed drawer is CSS — shell-targets-contrast.css.test.ts; the modal attributes and
 * the inert page are the shell's — app-shell.test.tsx.)
 *
 * Node env: the DOM is stand-ins. A stand-in element takes focus by becoming the document's
 * activeElement; `rects: 0` is an element with no box (`display: none`).
 */
function world({ modal = true } = {}) {
  const keyListeners = new Set<(e: KeyboardEvent) => void>();
  const clickListeners = new Set<(e: MouseEvent) => void>();
  const resizeListeners = new Set<() => void>();
  const doc = {
    activeElement: null as Element | null,
    body: { name: "body" } as unknown as Element,
    addEventListener: (_t: "keydown", fn: (e: KeyboardEvent) => void) => void keyListeners.add(fn),
    removeEventListener: (_t: "keydown", fn: (e: KeyboardEvent) => void) =>
      void keyListeners.delete(fn),
  };
  const focusLog: string[] = [];
  const el = (name: string, rects = 1, link = false) => {
    const e = {
      name,
      attrs: new Set<string>(),
      ownerDocument: doc,
      children: [] as { classList: { contains: (c: string) => boolean } }[],
      getClientRects: () => ({ length: rects }),
      setAttribute: (k: string) => void e.attrs.add(k),
      removeAttribute: (k: string) => void e.attrs.delete(k),
      closest: (sel: string) => (sel === "a[href]" && link ? e : null),
      focus: (options?: FocusOptions) => {
        focusLog.push(`${name}${options?.preventScroll ? " (preventScroll)" : ""}`);
        if (rects > 0) doc.activeElement = e as unknown as Element;
      },
    };
    return e;
  };
  const brand = el("brand", 1, true);
  const dashboard = el("dashboard", 1, true);
  const postings = el("postings", 1, true);
  const collapse = el("collapse", 0); // display:none below 1280px
  const scrim = el("scrim");
  const header = el("header-link", 1, true);
  const menu = el("menu");
  menu.children.push({ classList: { contains: (c: string) => c === "bb-icon-tip" } });
  const inRail = [brand, dashboard, postings, collapse];
  const close = vi.fn();
  let isModal = modal;
  const parts: DrawerParts = {
    doc,
    view: {
      addEventListener: (_t: "resize", fn: () => void) => void resizeListeners.add(fn),
      removeEventListener: (_t: "resize", fn: () => void) => void resizeListeners.delete(fn),
    },
    rail: {
      querySelectorAll: (() => inRail) as unknown as DrawerParts["rail"]["querySelectorAll"],
      contains: (n: Node | null) => inRail.some((x) => (x as unknown) === n),
      addEventListener: (_t: "click", fn: (e: MouseEvent) => void) => void clickListeners.add(fn),
      removeEventListener: (_t: "click", fn: (e: MouseEvent) => void) =>
        void clickListeners.delete(fn),
    },
    scrim: scrim as unknown as Element,
    menu: () => menu as unknown as HTMLElement,
    isModal: () => isModal,
    close,
  };
  const press = (key: string, shiftKey = false) => {
    const e = {
      key,
      shiftKey,
      defaultPrevented: false,
      preventDefault: () => (e.defaultPrevented = true),
    };
    for (const fn of keyListeners) fn(e as unknown as KeyboardEvent);
    return e;
  };
  const clickOn = (target: unknown) => {
    for (const fn of clickListeners) fn({ target } as unknown as MouseEvent);
  };
  const resize = (stillModal: boolean) => {
    isModal = stillModal;
    for (const fn of resizeListeners) fn();
  };
  const focused = () => (doc.activeElement as unknown as { name: string } | null)?.name ?? null;
  const listening = () => keyListeners.size + clickListeners.size + resizeListeners.size;
  return {
    doc,
    parts,
    press,
    clickOn,
    resize,
    focused,
    focusLog,
    listening,
    close,
    brand,
    dashboard,
    postings,
    collapse,
    scrim,
    header,
    menu,
  };
}

describe("drawerStops — the drawer's Tab stops", () => {
  it("its drawn focusables in order; a display:none control is not a stop, nor is the scrim", () => {
    const w = world();
    const names = drawerStops(w.parts.rail).map((s) => (s as unknown as { name: string }).name);
    expect(names).toEqual(["brand", "dashboard", "postings"]);
  });
});

describe("openDrawer — open: focus moves in and Tab stays inside", () => {
  it("opening moves focus to the first stop, without scrolling (it is still sliding in)", () => {
    const w = world();
    w.doc.activeElement = w.menu as unknown as Element;
    openDrawer(w.parts);
    expect(w.focused()).toBe("brand");
    expect(w.focusLog).toEqual(["brand (preventScroll)"]);
  });

  it("Tab on the last stop wraps to the first; Shift+Tab on the first wraps to the last", () => {
    const w = world();
    openDrawer(w.parts);
    w.postings.focus();
    expect(w.press("Tab").defaultPrevented).toBe(true);
    expect(w.focused()).toBe("brand");
    expect(w.press("Tab", true).defaultPrevented).toBe(true);
    expect(w.focused()).toBe("postings");
  });

  it("Tab between two inner stops is the browser's own (not intercepted)", () => {
    const w = world();
    openDrawer(w.parts);
    w.dashboard.focus();
    expect(w.press("Tab").defaultPrevented).toBe(false);
    expect(w.press("Tab", true).defaultPrevented).toBe(false);
    expect(w.focused()).toBe("dashboard");
  });

  it("focus that is somehow outside (the scrim after a click, the page) is pulled back in on Tab", () => {
    for (const outside of ["scrim", "header"] as const) {
      const w = world();
      openDrawer(w.parts);
      w[outside].focus();
      expect(w.press("Tab").defaultPrevented).toBe(true);
      expect(w.focused()).toBe("brand");
    }
  });

  it("Escape closes it", () => {
    const w = world();
    openDrawer(w.parts);
    w.press("Escape");
    expect(w.close).toHaveBeenCalledTimes(1);
  });

  it("activating ANY link in it closes it — the page already open too (no route change then)", () => {
    const w = world();
    openDrawer(w.parts);
    w.clickOn(w.brand);
    w.clickOn(w.dashboard);
    expect(w.close).toHaveBeenCalledTimes(2);
  });

  it("a click on something that is not a link (the rail's padding, the collapse button) does not", () => {
    const w = world();
    openDrawer(w.parts);
    w.clickOn(w.collapse);
    w.clickOn(null);
    expect(w.close).not.toHaveBeenCalled();
  });

  it("widening out of drawer mode closes it; a resize that stays in drawer mode does not", () => {
    const w = world();
    openDrawer(w.parts);
    w.resize(true);
    expect(w.close).not.toHaveBeenCalled();
    w.resize(false);
    expect(w.close).toHaveBeenCalledTimes(1);
  });

  it("not an overlay (≥1024px): focus is not moved and Tab is not contained; Escape still closes", () => {
    const w = world({ modal: false });
    w.doc.activeElement = w.menu as unknown as Element;
    openDrawer(w.parts);
    expect(w.focused()).toBe("menu");
    w.postings.focus();
    expect(w.press("Tab").defaultPrevented).toBe(false);
    w.press("Escape");
    expect(w.close).toHaveBeenCalledTimes(1);
  });
});

describe("openDrawer — closing: focus goes back to the menu button", () => {
  it.each(["postings", "scrim", "body"] as const)(
    "focus on %s (in the drawer, or lost with it) returns to the menu with its tooltip quiet",
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

  it("every listener is removed (Escape, a link, a resize no longer close; Tab no longer wraps)", () => {
    const w = world();
    const disarm = openDrawer(w.parts);
    expect(w.listening()).toBe(3);
    disarm();
    expect(w.listening()).toBe(0);
    w.press("Escape");
    w.clickOn(w.brand);
    w.resize(false);
    expect(w.close).not.toHaveBeenCalled();
  });

  it("an unmounted menu button (null) is not an error", () => {
    const w = world();
    const disarm = openDrawer({ ...w.parts, menu: () => null });
    expect(() => disarm()).not.toThrow();
  });
});
