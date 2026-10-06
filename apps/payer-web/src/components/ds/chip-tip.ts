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
 * While it stays shown it is measured again on every window resize: a phone turned or a window
 * dragged narrower re-flows the row under a tooltip measured once (768 → 320 with focus held left
 * 4 of 12 company-form tooltips 16px past the screen's left edge). One resize listener per shown
 * tooltip, added when it shows and removed when it hides or its chip unmounts.
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

/** What a shown tooltip listens to — the browser `window` fits. */
export interface TipWindow {
  addEventListener(type: "resize", listener: () => void): void;
  removeEventListener(type: "resize", listener: () => void): void;
}

/** How far a tooltip starting at `tipLeft` must slide right to start at the row's start. */
export const tipOverrun = (rowLeft: number, tipLeft: number): number =>
  Math.max(0, Math.ceil(rowLeft - tipLeft));

/** The button's tooltip while it is shown (a hidden one has no box), else null. */
const shownTip = (button: TipHost) => {
  const tip = button.querySelector(".bb-icon-tip");
  return tip !== null && tip.getClientRects().length > 0 ? tip : null;
};

/**
 * Keep `button`'s tooltip inside the chip's row (see above). A hidden tooltip is left alone.
 * Returns whether the tooltip is shown.
 */
export function keepTipInRow(button: TipHost): boolean {
  button.style.removeProperty(TIP_SHIFT_PROPERTY);
  const tip = shownTip(button);
  if (tip === null) return false;
  const row = button.closest(".bb-chip")?.parentElement ?? null;
  if (row === null) return true;
  const shift = tipOverrun(row.getBoundingClientRect().left, tip.getBoundingClientRect().left);
  if (shift > 0) button.style.setProperty(TIP_SHIFT_PROPERTY, String(shift));
  return true;
}

/** The resize listener's removal, per button whose shown tooltip is being kept in its row. */
const watches = new WeakMap<TipHost, () => void>();

/**
 * The tooltip may have just SHOWN (focus, pointer enter): place it, and keep it placed on every
 * resize while it stays shown. Focus and hover can both show it — it is watched once.
 */
export function showTip(button: TipHost, win: TipWindow): void {
  if (!keepTipInRow(button) || watches.has(button)) return;
  const onResize = () => {
    // Hidden with no blur / pointer leave (Escape dismissed it, or the chip is gone): stop here.
    if (!keepTipInRow(button)) unwatchTip(button);
  };
  win.addEventListener("resize", onResize);
  watches.set(button, () => win.removeEventListener("resize", onResize));
}

/**
 * A trigger ENDED (blur, pointer leave): stop watching once the tooltip is hidden. Focus and hover
 * both show it, so the end of one can leave it shown — still watched.
 */
export function hideTip(button: TipHost): void {
  if (shownTip(button) === null) unwatchTip(button);
}

/** Stop watching whatever the tooltip's state — its chip unmounts. */
export function unwatchTip(button: TipHost): void {
  watches.get(button)?.();
  watches.delete(button);
}
