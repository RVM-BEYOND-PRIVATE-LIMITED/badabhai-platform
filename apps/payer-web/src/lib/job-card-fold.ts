/**
 * WHERE THE PHONE CUTS THE CARD — and how many chips that hides.
 *
 * The worker's deck card has no scroll: its content box is a fixed height and anything below it
 * is clipped (`design1_job_card.dart`, "the clip IS the contract"). The preview draws the same
 * clip at the reference phone's content height (`REFERENCE_PHONE` in job-card-view.ts), so a long
 * chip list is cut on the payer's screen exactly where a worker's phone cuts it. Cutting it
 * SILENTLY would hide the very thing the payer needs to know, so the preview says how many chips
 * fall below the line and lets the payer expand the card to see them all.
 *
 * Counting needs real layout (chip widths decide how many rows they wrap to), so it runs in the
 * browser: {@link observeChipFold} is a React ref callback — no hook, so the preview stays a plain
 * function component — that re-counts whenever the card's size or its text changes.
 */

/** A chip whose box runs past the clip line is (at least partly) hidden on the phone. */
export function countClippedChips(clipLine: number, chipBottoms: readonly number[]): number {
  // Half a pixel of tolerance: sub-pixel rounding must not count a chip that ends ON the line.
  return chipBottoms.filter((bottom) => bottom > clipLine + 0.5).length;
}

/** The fold summary's wording for `n` hidden chips. */
export function clippedChipsLabel(n: number): string {
  return n === 1 ? "1 chip" : `${n} chips`;
}

/**
 * Ref callback for the card's content box (`.jcp__content`). Finds the clip line marker and the
 * chips inside it, counts the chips below the line, and writes the count onto the figure's fold
 * control (`data-cut` drives its visibility in CSS; the count text is a node React renders empty
 * and never reconciles). Returns the cleanup React 19 calls on unmount.
 */
export function observeChipFold(content: HTMLElement | null): (() => void) | undefined {
  if (content === null || typeof ResizeObserver === "undefined") return undefined;
  const figure = content.closest(".jcp");
  const fold = figure?.querySelector<HTMLElement>("[data-fold]") ?? null;
  const count = fold?.querySelector<HTMLElement>("[data-fold-count]") ?? null;
  const line = content.querySelector<HTMLElement>("[data-fold-line]");
  if (fold === null || count === null || line === null) return undefined;

  const update = () => {
    const clipLine = line.getBoundingClientRect().top;
    const chips = Array.from(content.querySelectorAll<HTMLElement>(".jcp__chip"));
    const n = countClippedChips(
      clipLine,
      chips.map((chip) => chip.getBoundingClientRect().bottom),
    );
    fold.dataset.cut = String(n);
    count.textContent = clippedChipsLabel(n);
  };

  const resize = new ResizeObserver(update);
  resize.observe(content);
  const flow = content.firstElementChild;
  if (flow !== null) resize.observe(flow);
  // A chip removed from a row that stays (same height) changes the count without a resize.
  const mutation = new MutationObserver(update);
  mutation.observe(content, { childList: true, subtree: true, characterData: true });
  update();
  return () => {
    resize.disconnect();
    mutation.disconnect();
  };
}
