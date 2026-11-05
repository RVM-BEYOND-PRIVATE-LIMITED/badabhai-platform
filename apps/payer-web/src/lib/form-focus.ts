/**
 * Focus helpers the posting forms share (company create/edit, agency create/edit).
 */

/** Moves focus (and so the scroll) to a control the payer has to fix. A no-op outside a browser. */
export function focusControl(id: string): void {
  if (typeof document === "undefined") return;
  document.getElementById(id)?.focus();
}

/**
 * {@link focusControl} for a control the same click is about to SHOW (a step switch): on the next
 * frame, after React has drawn it. A no-op outside a browser.
 */
export function focusControlOnNextFrame(id: string): void {
  if (typeof window === "undefined") return;
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(() => focusControl(id));
  } else focusControl(id);
}

/**
 * True when no control holds focus: the one that had it was removed (a Retry button a re-read
 * replaced), or focus was never placed. A form may take focus back only then. Moving it off a
 * control the payer is using takes their typing with it (into a select, whose type-ahead then
 * changes the pick). False outside a browser.
 */
export function focusIsLost(): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  return active === null || active === document.body;
}

/**
 * A multi-line control is shown WHOLE when it takes focus. Chrome scrolls only the caret's line of
 * a focused textarea into view, which left the description's lower lines (and its hint) under the
 * fold. `nearest` keeps the scroll minimal and honours the fields' scroll margins (the sticky
 * header above; the phone dock below).
 */
export function revealWholeControl(event: { currentTarget: Element }): void {
  event.currentTarget.scrollIntoView({ block: "nearest" });
}

/**
 * W4 (#2584) — a multi-step form's step change lands the payer on the NEW step's heading: focus
 * moves there (it is `tabIndex={-1}`) and it is scrolled to the top of the view — smoothly, or
 * at once under reduced motion. Runs on the next frame, after React has shown the step. A no-op
 * outside a browser.
 */
export function focusStepHeading(id: string): void {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const run = () => {
    const heading = document.getElementById(id);
    if (heading === null) return;
    heading.focus({ preventScroll: true });
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    heading.scrollIntoView?.({ block: "start", behavior: reduce ? "auto" : "smooth" });
  };
  if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(run);
  else run();
}
