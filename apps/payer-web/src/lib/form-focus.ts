/**
 * Focus helpers the posting forms share (company create/edit, agency create/edit).
 */

/** Moves focus (and so the scroll) to a control the payer has to fix. A no-op outside a browser. */
export function focusControl(id: string): void {
  if (typeof document === "undefined") return;
  document.getElementById(id)?.focus();
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
