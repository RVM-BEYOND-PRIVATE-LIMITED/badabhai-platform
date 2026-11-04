import { focusableIn, trapTab, type Focusable, type FocusRoot } from "./drawer-focus";

/**
 * Keyboard focus for a modal overlay — Dialog and Drawer (A5, #2575).
 *
 * The same contract as the navigation drawer (`drawer-focus.ts`, whose Tab-wrapping it reuses),
 * plus the two things a dialog opened FROM a control needs:
 *   - `initial`: where focus starts (a T3 confirm starts on Cancel, so a stray Enter never
 *     confirms a destructive action); by default the overlay's first control, else the panel;
 *   - `returnTo`: the trigger, focused again when the overlay is released (closed).
 *
 * Tab / Shift+Tab wrap inside the overlay and Escape calls `onEscape`. Written against the narrow
 * surface it uses so the node test env drives it with stand-ins (overlay-focus.test.ts).
 *
 * OVERLAYS STACK (A7, #2577): a confirm can open OVER a drawer (the phone reveal's reason). Every
 * hold listens on the same window, so only the TOPMOST one — the last still held — answers a
 * key: Escape closes the confirm and leaves the drawer open, and Tab cycles the confirm's
 * controls instead of being pulled back into the drawer under it. Releasing the top hands the
 * keys back to the one beneath.
 *
 * AN OVERLAY CAN OUTLIVE ITS TRIGGER (A7, #2577): a drawer that ↑/↓ moved on to another row, or a
 * confirm whose success replaced the button that opened it. `returnFocus` is asked AT RELEASE
 * where focus belongs now (the row the drawer is on, the value just revealed); when it names
 * nothing still on the page, focus goes back to `returnTo` as before.
 */
const held: object[] = [];

/** Anything focus can be handed to. */
interface FocusTarget {
  focus(): void;
}

/** Is this hold the topmost one still held — the overlay a key press belongs to? */
function isTopHold(token: object): boolean {
  return held[held.length - 1] === token;
}

/** Still in the document? Only an element known to have left it (`isConnected`) is not. */
function onPage(target: FocusTarget): boolean {
  return (target as { isConnected?: boolean }).isConnected !== false;
}

export function holdFocus<T extends Focusable>({
  container,
  keyTarget,
  activeElement,
  onEscape,
  initial,
  returnTo,
  returnFocus,
}: {
  container: FocusRoot<T> & { focus(): void };
  keyTarget: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  activeElement: () => unknown;
  onEscape: () => void;
  initial?: FocusTarget | null;
  /** The trigger: focused again on release, unless `returnFocus` names a better place. */
  returnTo?: FocusTarget | null;
  /** Where focus belongs on release, asked then — see "an overlay can outlive its trigger". */
  returnFocus?: () => FocusTarget | null;
}): () => void {
  const token = {};
  held.push(token);
  (initial ?? focusableIn(container)[0] ?? container).focus();

  const onKey = (event: Event) => {
    // Another overlay opened over this one: its hold answers the key, not this.
    if (!isTopHold(token)) return;
    const { key, shiftKey } = event as KeyboardEvent;
    if (key === "Escape") {
      event.preventDefault();
      onEscape();
      return;
    }
    if (key !== "Tab") return;
    const target = trapTab(focusableIn(container), activeElement(), shiftKey);
    if (target) {
      event.preventDefault();
      target.focus();
    }
  };

  keyTarget.addEventListener("keydown", onKey);
  return () => {
    keyTarget.removeEventListener("keydown", onKey);
    const at = held.indexOf(token);
    if (at >= 0) held.splice(at, 1);
    const preferred = returnFocus?.() ?? null;
    (preferred && onPage(preferred) ? preferred : returnTo)?.focus();
  };
}
