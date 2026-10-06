import { focusWithoutTooltip } from "@badabhai/icons";
import { FOCUSABLE_SELECTOR } from "../../components/ds/focusable";

/**
 * THE NAV DRAWER'S KEYBOARD MODEL — below 1024px the rail is an overlay drawer (app-shell.tsx),
 * and while open it is MODAL: a labelled `role="dialog"` with `aria-modal`, the page behind it
 * `inert` (both in app-shell.tsx), and this module holding the keyboard.
 *
 *   closed  out of the Tab order and the accessibility tree: `visibility: hidden` (globals.css).
 *           Off-screen is not hidden — measured at 375 and 900px, its seven links were the first
 *           seven Tab stops of every page, before the menu button that opens it.
 *   open    focus moves to its first control (without scrolling: it is still sliding in);
 *           Tab / Shift+Tab wrap inside it; Escape closes it, and so does activating any link in
 *           it — a link to the page already open (the brand, "Dashboard" on /dashboard) changes
 *           no route, so the route-change close never fires for it — and so does leaving drawer
 *           mode (widening past the breakpoint would leave the page `inert` behind a rail that is
 *           permanent again).
 *   closing focus returns to the menu button when it was in the drawer (or was lost with it), with
 *           the button's tooltip kept quiet — the app put focus there, the user did not.
 *
 * The scrim is a pointer target only (never a Tab stop: it covers the viewport, so its focus
 * ring would be drawn off-screen). `isModal` says whether the rail is a drawer right now by
 * reading whether the scrim is drawn, so the breakpoint lives in the stylesheet only.
 */

/** The DOM the model needs — real elements in the app, stand-ins in the tests. */
export interface DrawerParts {
  doc: {
    readonly activeElement: Element | null;
    readonly body: Element | null;
    addEventListener(type: "keydown", fn: (e: KeyboardEvent) => void): void;
    removeEventListener(type: "keydown", fn: (e: KeyboardEvent) => void): void;
  };
  /** Where a viewport resize is heard (the window). */
  view: {
    addEventListener(type: "resize", fn: () => void): void;
    removeEventListener(type: "resize", fn: () => void): void;
  };
  rail: Pick<HTMLElement, "querySelectorAll" | "contains"> & {
    addEventListener(type: "click", fn: (e: MouseEvent) => void): void;
    removeEventListener(type: "click", fn: (e: MouseEvent) => void): void;
  };
  scrim: Element | null;
  /** The menu button that opened the drawer (looked up when focus goes back to it). */
  menu: () => HTMLElement | null;
  /** Is the rail an overlay drawer right now (the scrim is drawn)? */
  isModal: () => boolean;
  close: () => void;
}

/** The drawer's Tab stops in order: its drawn focusables (a `display: none` control has no box). */
export function drawerStops(rail: DrawerParts["rail"]): HTMLElement[] {
  return Array.from(rail.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.getClientRects().length > 0,
  );
}

/**
 * Arm the open drawer: move focus in, contain Tab, close on Escape / a link / leaving drawer mode.
 * Returns the disarm, which hands focus back to the menu button. Call it when the drawer opens;
 * call the disarm when it closes (and on unmount).
 */
export function openDrawer(parts: DrawerParts): () => void {
  const { doc, view, rail, scrim } = parts;
  if (parts.isModal()) drawerStops(rail)[0]?.focus({ preventScroll: true });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      parts.close();
      return;
    }
    if (e.key !== "Tab" || !parts.isModal()) return;
    const stops = drawerStops(rail);
    if (stops.length === 0) return;
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    const active = doc.activeElement;
    const inside = stops.some((s) => s === active);
    if (e.shiftKey ? !inside || active === first : !inside || active === last) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  };
  // Any link activation (click, or Enter on a focused link) closes the drawer.
  const onClick = (e: MouseEvent) => {
    const target = e.target as { closest?: (s: string) => unknown } | null;
    if (target?.closest?.("a[href]")) parts.close();
  };
  const onResize = () => {
    if (!parts.isModal()) parts.close();
  };
  doc.addEventListener("keydown", onKeyDown);
  rail.addEventListener("click", onClick);
  view.addEventListener("resize", onResize);

  return () => {
    doc.removeEventListener("keydown", onKeyDown);
    rail.removeEventListener("click", onClick);
    view.removeEventListener("resize", onResize);
    const active = doc.activeElement;
    const wasInDrawer =
      active === null || active === doc.body || active === scrim || rail.contains(active);
    const menu = parts.menu();
    if (wasInDrawer && menu) focusWithoutTooltip(menu);
  };
}
