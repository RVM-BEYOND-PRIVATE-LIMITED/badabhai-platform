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
 */
export function holdFocus<T extends Focusable>({
  container,
  keyTarget,
  activeElement,
  onEscape,
  initial,
  returnTo,
}: {
  container: FocusRoot<T> & { focus(): void };
  keyTarget: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  activeElement: () => unknown;
  onEscape: () => void;
  initial?: { focus(): void } | null;
  returnTo?: { focus(): void } | null;
}): () => void {
  (initial ?? focusableIn(container)[0] ?? container).focus();

  const onKey = (event: Event) => {
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
    returnTo?.focus();
  };
}
