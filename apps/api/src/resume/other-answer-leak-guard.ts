/**
 * The payer-facing chokepoint's LAST LINE OF DEFENCE against an unreviewed "other" answer
 * (`worker_pack_answer.answer_other_text` / `answer_other_text_polished`) reaching the employer
 * disclosure.
 *
 * WHY THIS EXISTS, GIVEN THE PRIMARY DEFENCE IS "NEVER WIRE IT IN". The primary defence is that
 * nothing on the disclosure path reads `worker_pack_answer` at all — `WorkerAttributesRepository
 * .loadTradeSheet` reads only `worker_attributes`, and `answer-map-projector.ts`'s
 * `classifyAttributeValue` already refuses to turn the "other" marker object into an attribute
 * (see `OtherAnswerValue` in `pack-answer-row.ts`). That keeps an "other" answer out of the payer
 * surface BY CONSTRUCTION today.
 *
 * "By construction, today" is not a standing guarantee — R32 (this repo's name-masking work) is
 * MEASURED, NOT CLOSED, and the ruling for this feature is explicit that the reviewed text is
 * worker-facing only until it closes. A future change to `loadTradeSheet`, a new field on
 * `TradeSheetContext`, or a well-meaning "just print what the worker typed" patch could reconnect
 * the two without anyone here noticing, because nothing currently asserts they stay apart. This
 * is that assertion: `ResumeDisclosureService.renderAndDisclose` calls it on the fully-built
 * `TradeSheetContext` right before the payer-facing render, and a hit fails the WHOLE disclosure
 * closed (never partially) — same discipline as every other guard on that path.
 */

/** The `OtherAnswerValue` shape, checked structurally so this file never imports the profiling
 *  module (this is `resume/`, a downstream consumer, and must not depend on `profiling/`). */
function isOtherAnswerMarker(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "other_answer" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

/** Bounded so a pathological payload cannot turn this guard into the thing that hangs a render. */
const MAX_SCAN_NODES = 5_000;

/**
 * Deep-scans `value` for anything shaped like an unreviewed "other" answer marker.
 *
 * TRUE ON THE MARKER SHAPE ONLY, never on an ordinary string — a `TradeSheetContext` is full of
 * worker-authored strings and this guard would be useless (and would block every disclosure) if
 * it flagged text generally. It exists to catch the ONE shape that means "this came straight off
 * `answer_other_text` without going through the polish review", because that shape is what
 * `pack-answer-row.ts` manufactures and nothing else in this codebase does.
 */
export function containsOtherAnswerMarker(value: unknown, budget = { n: MAX_SCAN_NODES }): boolean {
  if (budget.n-- <= 0) return false;
  if (isOtherAnswerMarker(value)) return true;
  if (Array.isArray(value)) return value.some((entry) => containsOtherAnswerMarker(entry, budget));
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((entry) =>
      containsOtherAnswerMarker(entry, budget),
    );
  }
  return false;
}
