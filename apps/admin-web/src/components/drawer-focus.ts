/**
 * Keyboard focus for the navigation drawer below 1024px (`Shell`, final sweep AW-04).
 *
 * An open drawer is modal: it covers the page with a scrim, and the shell marks everything
 * behind it `inert`. This holds the keyboard inside it — focus moves in when it opens, Tab and
 * Shift+Tab cycle through its controls instead of leaving for the page behind the scrim (or the
 * browser's own chrome), and Escape closes it. The shell returns focus to the menu toggle on
 * close. (A CLOSED drawer is out of the tab order by CSS — `visibility: hidden` in globals.css.)
 *
 * Written against the narrow surface it uses rather than the DOM types, so the node test env
 * can drive it with stand-ins (drawer-focus.test.ts).
 */

/** What the drawer needs of a control. */
export interface Focusable {
  focus(): void;
  tabIndex: number;
  getClientRects(): { length: number };
}

/** What the drawer needs of its container. */
export interface FocusRoot<T extends Focusable> {
  querySelectorAll(selectors: string): ArrayLike<T>;
}

/** Every kind of element that can take a Tab stop, enabled. */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]",
].join(", ");

/** The container's Tab stops in document order: in the tab order, and rendered. */
export function focusableIn<T extends Focusable>(root: FocusRoot<T>): T[] {
  return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
    (el) => el.tabIndex >= 0 && el.getClientRects().length > 0,
  );
}

/**
 * Where a Tab press must be redirected to keep focus inside the drawer, or null to let the
 * browser move it (anywhere strictly inside the run of controls).
 *
 * - forwards from the last control → the first; backwards from the first → the last;
 * - focus that is not on any of them (it reached the body, or something behind the scrim) is
 *   brought back to the start (or the end, going backwards).
 */
export function trapTab<T>(
  focusables: readonly T[],
  active: unknown,
  backwards: boolean,
): T | null {
  if (focusables.length === 0) return null;
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  const at = focusables.indexOf(active as T);
  if (at < 0) return backwards ? last : first;
  if (backwards && at === 0) return last;
  if (!backwards && at === focusables.length - 1) return first;
  return null;
}

/**
 * Holds the keyboard in an OPEN drawer until the returned release is called: focus moves to the
 * drawer's first control now, Tab / Shift+Tab wrap inside it, Escape calls `onClose`.
 *
 * `keyTarget` is where keydown is listened for (the window); `activeElement` reads the focused
 * element at the moment of the key press.
 */
export function holdFocusInDrawer<T extends Focusable>({
  drawer,
  keyTarget,
  activeElement,
  onClose,
}: {
  drawer: FocusRoot<T>;
  keyTarget: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  activeElement: () => unknown;
  onClose: () => void;
}): () => void {
  focusableIn(drawer)[0]?.focus();

  const onKey = (event: Event) => {
    const { key, shiftKey } = event as KeyboardEvent;
    if (key === "Escape") {
      onClose();
      return;
    }
    if (key !== "Tab") return;
    const target = trapTab(focusableIn(drawer), activeElement(), shiftKey);
    if (target) {
      event.preventDefault();
      target.focus();
    }
  };

  keyTarget.addEventListener("keydown", onKey);
  return () => keyTarget.removeEventListener("keydown", onKey);
}
