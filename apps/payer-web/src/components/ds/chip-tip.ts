/**
 * A removable chip's tooltip stays INSIDE its row of chips.
 *
 * The remove button's tooltip ("Remove Fanuc control") is anchored at the chip's END and grows
 * toward the row's start (`tooltipPlacement="top-end"`), so it can never widen the page; its
 * width is capped at the row's (`max-width: … 100cqi`, the row being an inline-size container).
 * What the CSS cannot know is WHERE in the row the chip sits: a short chip that starts a row on a
 * phone pushed its tooltip up to 20px past the screen's left edge (10 of 19 at 320px). So when the
 * tooltip shows — keyboard focus, pointer hover — it is measured, and slid right by exactly its
 * overrun past the row's start. (Anchoring at the chip's START instead sent 17 of 19 off the right
 * edge at 320px, with 239px of sideways scroll.)
 *
 * A DOM nudge, not state: a unitless pixel count in `--bb-tip-shift` on the button, consumed by
 * the chip CSS (ds-components.css). Structural types, so it is testable without a browser.
 */
export const TIP_SHIFT_PROPERTY = "--bb-tip-shift";

/** What the nudge reads and writes — a real remove `<button>` fits. */
export interface TipHost {
  readonly style: { setProperty(name: string, value: string): void; removeProperty(name: string): string };
  querySelector(selector: string): {
    getClientRects(): ArrayLike<unknown>;
    getBoundingClientRect(): { left: number };
  } | null;
  closest(selector: string): { readonly parentElement: { getBoundingClientRect(): { left: number } } | null } | null;
}

/** How far a tooltip starting at `tipLeft` must slide right to start at the row's start. */
export const tipOverrun = (rowLeft: number, tipLeft: number): number =>
  Math.max(0, Math.ceil(rowLeft - tipLeft));

/** Keep `button`'s tooltip inside the chip's row (see above). A hidden tooltip is left alone. */
export function keepTipInRow(button: TipHost): void {
  button.style.removeProperty(TIP_SHIFT_PROPERTY);
  const tip = button.querySelector(".bb-icon-tip");
  const row = button.closest(".bb-chip")?.parentElement ?? null;
  if (tip === null || row === null || tip.getClientRects().length === 0) return;
  const shift = tipOverrun(row.getBoundingClientRect().left, tip.getBoundingClientRect().left);
  if (shift > 0) button.style.setProperty(TIP_SHIFT_PROPERTY, String(shift));
}
