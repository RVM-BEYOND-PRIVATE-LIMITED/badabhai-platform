import { focusWithoutTooltip } from "@badabhai/icons";

/**
 * THE NAV DRAWER'S KEYBOARD MODEL — below 1024px the rail is an overlay drawer (app-shell.tsx).
 *
 *   closed  out of the Tab order and the accessibility tree: `visibility: hidden` (globals.css).
 *           Off-screen is not hidden — measured at 375 and 900px, its seven links were the first
 *           seven Tab stops of every page, before the menu button that opens it.
 *   open    focus moves to its first stop; Tab / Shift+Tab wrap inside it (its links and the
 *           scrim's "Close navigation"); Escape closes it.
 *   closing focus returns to the menu button when it was in the drawer (or was lost with it), with
 *           the button's tooltip kept closed — the app put focus there, the user did not.
 *
 * At ≥1024px the rail is not a drawer and none of this applies. `isModal` says which is the case
 * by reading whether the scrim is drawn, so the breakpoint lives in the stylesheet only.
 */

/** What can take focus inside the drawer (the Dialog's list). */
export const DRAWER_FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The DOM the model needs — real elements in the app, stand-ins in the tests. */
export interface DrawerParts {
  doc: {
    readonly activeElement: Element | null;
    readonly body: Element | null;
    addEventListener(type: "keydown", fn: (e: KeyboardEvent) => void): void;
    removeEventListener(type: "keydown", fn: (e: KeyboardEvent) => void): void;
  };
  rail: Pick<HTMLElement, "querySelectorAll" | "contains">;
  scrim: HTMLElement | null;
  /** The menu button that opened the drawer (looked up when focus goes back to it). */
  menu: () => HTMLElement | null;
  /** Is the rail an overlay drawer right now (the scrim is drawn)? */
  isModal: () => boolean;
  close: () => void;
}

/** The drawer's Tab stops in order: its drawn focusables, then the scrim. */
export function drawerStops(rail: DrawerParts["rail"], scrim: HTMLElement | null): HTMLElement[] {
  const inRail = Array.from(rail.querySelectorAll<HTMLElement>(DRAWER_FOCUSABLE)).filter(
    // `display: none` (the collapse button below 1280px) has no box and cannot take focus.
    (el) => el.getClientRects().length > 0,
  );
  return scrim ? [...inRail, scrim] : inRail;
}

/**
 * Arm the open drawer: move focus in, contain Tab, close on Escape. Returns the disarm, which
 * hands focus back to the menu button. Call it when the drawer opens; call the disarm when it
 * closes (and on unmount).
 */
export function openDrawer(parts: DrawerParts): () => void {
  const { doc, rail, scrim } = parts;
  if (parts.isModal()) drawerStops(rail, scrim)[0]?.focus();

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      parts.close();
      return;
    }
    if (e.key !== "Tab" || !parts.isModal()) return;
    const stops = drawerStops(rail, scrim);
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
  doc.addEventListener("keydown", onKeyDown);

  return () => {
    doc.removeEventListener("keydown", onKeyDown);
    const active = doc.activeElement;
    const wasInDrawer =
      active === null || active === doc.body || active === scrim || rail.contains(active);
    const menu = parts.menu();
    if (wasInDrawer && menu) focusWithoutTooltip(menu);
  };
}
