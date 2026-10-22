import type { QuestionPackItem } from "@badabhai/ai-contracts";

type PackOption = QuestionPackItem["options"][number];

/**
 * A pack's own "something else" chips, already normalized (NFKC, lower case, single spaces).
 *
 * WHY THE FORM DROPS THEM (#2397). Every single- and multi-select question on the trade form takes
 * a typed answer ("typed custom answer, everywhere", owner ruling round 4), and the app draws that
 * as its own "Koi aur — khud likhein" card under the options. A pack that ALSO offers
 * "Koi aur machine" shows the worker two "other" options on one screen. The pack chip is the worse
 * of the two, because it stores `unknown` while the card stores what he actually typed.
 *
 * FORM ONLY. The pack data is untouched and the chat still serves these chips: a chat pack question
 * has no typed escape, so there "Koi aur machine" is the only way to say "not in this list".
 *
 * A CLOSED SET, compared against the WHOLE label, like `ESCAPE_CHIP_ALIASES`. "Inme se koi nahi"
 * (none of these), "Pata nahi" and "Setting koi aur karta hai" (someone else does it) are real
 * answers, not escapes, and must survive. Missing a new label costs one duplicate-looking chip.
 * Matching too broadly would silently remove a real answer, which is worse. The corpus test in
 * `form-redundant-options.test.ts` fails when a pack gains a "Koi aur …" escape this set lacks.
 */
const FORM_REDUNDANT_OTHER_LABELS: ReadonlySet<string> = new Set([
  "koi aur",
  "koi aur machine",
  "koi aur software",
  "koi aur line",
  "koi aur tarah ki",
]);

/** NFKC → lower case → single spaces. Deliberately no particle stripping: whole labels only. */
function normalizeLabel(label: string): string {
  return label.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
}

/** Whether the form leaves out {@link option}, because its "Koi aur — khud likhein" card replaces it. */
export function isFormRedundantOther(option: PackOption): boolean {
  return (
    option.is_none_of_above && FORM_REDUNDANT_OTHER_LABELS.has(normalizeLabel(option.label_text))
  );
}

/**
 * The options the trade form serves for {@link item}.
 *
 * A PICK IS NEVER HIDDEN. A worker who ticked "Koi aur machine" before #2397 still sees it ticked
 * on a reopened form, so he can untick it. Hiding it would leave a selection on the wire that he
 * cannot see or change. Answer validation keeps reading the full pack (`recordFor`), so a build
 * that still sends the key is accepted.
 */
export function formServedOptions(
  item: QuestionPackItem,
  pickedKeys: readonly string[],
): PackOption[] {
  if (item.answer_type !== "single_select" && item.answer_type !== "multi_select") {
    return [...item.options];
  }
  const picked = new Set(pickedKeys);
  return item.options.filter(
    (option) => !isFormRedundantOther(option) || picked.has(option.option_key),
  );
}
