import type { QuestionPackItem } from "@badabhai/ai-contracts";
import { parseAffirmation } from "@badabhai/profiling-lexicon";

import type { AnswerMap, CapturedValue } from "./answer-map";
import type { ResumeSuggestion } from "./resume-import/resume-suggestions";

/**
 * The batch-confirm turn — one ask that settles several facts a résumé already told us
 * (ADR-0041, phase RI-5).
 *
 * ── THIS IS THE ONLY PLACE THE ASK BUDGET IS ACTUALLY RECOVERED ──────────────────────────
 *
 * `MAX_ENGINE_ASKS` is 28 and a senior CNC turner already spends 23 of the 24 the authoring
 * guide budgets. Everything before this phase made a résumé's facts AVAILABLE; nothing made
 * them CHEAP — a worker routed to the chat still answered trade, experience, city, salary,
 * education and availability one question at a time. This turn asks once and settles all six.
 *
 * IT SPENDS AN ASK, AND MUST. It is a question, the worker can decline it, and hiding it from
 * `engineAsks` would make the budget a number that no longer describes what the worker was
 * asked — which is the one thing the abandonment measurement depends on. Six asks become one,
 * not zero.
 *
 * ── CONFIRMATION IS WHAT MAKES THEM ANSWERS (ruling D2) ──────────────────────────────────
 *
 * NOTHING HERE IS SEEDED INTO THE ANSWER MAP BEFOREHAND, and the approved plan's phrasing —
 * "seed the envelope's answerMap with unconfirmed parsed facts" — cannot be implemented as
 * written. `ANSWER_STATUSES` is `answered | declined | unanswered | superseded`; there is no
 * "unconfirmed". A seeded record would therefore be indistinguishable from something the
 * worker said, `packAnswerRowFor` would carry it into `worker_pack_answer`, and every
 * projector, gate and event downstream would treat a parsed guess as his claim. That is
 * precisely the failure ruling D2 exists to prevent, and the plan's very next sentence —
 * "confirmation is what makes them answers" — is the half that holds.
 *
 * So the suggestions stay where RI-4 put them (encrypted, on the import row), this module
 * turns them into a QUESTION, and only a "haan" produces `CapturedValue`s.
 *
 * ── THE CONFIRMED ANSWER'S PROVENANCE IS THE WORKER, NOT THE DOCUMENT ────────────────────
 *
 * {@link confirmedValues} writes `valueRaw: null` and `evidence: null`, deliberately. The
 * worker's words were "haan"; the document's line is not his sentence and must not enter the
 * interview record as though it were. Ruling D4 keeps résumé text off the sheet, and the
 * cheapest way to honour that is for the text never to reach the transcript projection at all.
 */

/** One fact the worker is asked to confirm, already resolved against the pack. */
export interface ResumeConfirmFact {
  readonly questionKey: string;
  readonly targetField: string | null;
  /** What the interview would have stored had he answered the question himself. */
  readonly valueNormalized: unknown;
  /** What he READS — an option's own label, or the value as printed. */
  readonly display: string;
}

/**
 * Which suggestions are worth asking about, in the pack's own order.
 *
 * A STORED ANSWER IS NEVER OFFERED (ruling D7). A worker who has already told us his city is
 * not asked to confirm what his résumé says about it — his answer stands, and re-opening it
 * would spend the turn re-litigating something settled. Note this differs from the FORM, where
 * the suggestion is shown BESIDE the stored answer: there he can see both at a glance and
 * change his mind for free, whereas here the only way to show it is to spend the ask.
 *
 * ORDER IS THE PACK'S, not the suggestion map's. The map is keyed by question and iterates in
 * insertion order, which is the model's output order — so without this the same résumé could
 * produce two different bubbles on two runs, and the copy would be untestable.
 */
export function confirmableFacts(
  suggestions: ReadonlyMap<string, ResumeSuggestion>,
  items: readonly QuestionPackItem[],
  answers: AnswerMap,
): ResumeConfirmFact[] {
  const facts: ResumeConfirmFact[] = [];

  for (const item of [...items].sort((a, b) => a.display_order - b.display_order)) {
    const suggestion = suggestions.get(item.question_key);
    if (suggestion === undefined) continue;

    const settled = answers[item.question_key];
    if (settled !== undefined && settled.status !== "unanswered") continue;

    const resolved = resolve(item, suggestion);
    if (resolved === null) continue;
    facts.push(resolved);
  }
  return facts;
}

/**
 * A suggestion → the value the interview stores, plus the words the worker reads.
 *
 * THE STORED VALUE AND THE DISPLAYED ONE ARE DIFFERENT THINGS, and conflating them is the
 * defect this shape exists to prevent. `education` stores `iti_diploma`; a worker must be shown
 * "ITI / Diploma". Reading the stored value aloud would ask him to confirm a database token.
 */
function resolve(item: QuestionPackItem, suggestion: ResumeSuggestion): ResumeConfirmFact | null {
  const base = { questionKey: item.question_key, targetField: item.target_field };
  const { option_keys: optionKeys, text, number, bool } = suggestion.values;

  if (optionKeys.length > 0) {
    const chosen = item.options.filter((option) => optionKeys.includes(option.option_key));
    if (chosen.length === 0) return null;
    const values = chosen.map((option) => optionValue(option));
    return {
      ...base,
      // A single-select stores the bare value; a multi-select stores the array. Reading the
      // pack's own `answer_type` rather than counting the matches is what keeps a multi-select
      // with one chip selected from being stored as a scalar.
      valueNormalized: item.answer_type === "multi_select" ? values : values[0],
      display: chosen.map((option) => option.label_text).join(", "),
    };
  }

  if (typeof number === "number" && Number.isFinite(number)) {
    return { ...base, valueNormalized: number, display: String(number) };
  }
  if (typeof bool === "boolean") {
    return { ...base, valueNormalized: bool, display: bool ? "Haan" : "Nahi" };
  }
  if (typeof text === "string" && text.trim().length > 0) {
    return { ...base, valueNormalized: text.trim(), display: text.trim() };
  }
  return null;
}

function optionValue(option: QuestionPackItem["options"][number]): string | number | boolean {
  const value = option.value;
  if (typeof value === "string") return value.length > 0 ? value : option.label_text;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return option.label_text;
}

/**
 * The bubble. One sentence, the facts as a middot-separated list, one question mark.
 *
 * NOT GENERATED, and not persona-checked for that reason — it is reviewed server copy in the
 * same class as the trade-form handover's, and the only variable part is the worker's own
 * values. A model asked to phrase this would be a model that could phrase it differently on a
 * retry, for a turn whose whole purpose is that the worker recognises what he wrote down.
 */
export function confirmPrompt(facts: readonly ResumeConfirmFact[]): string {
  return `Resume se ye mila: ${facts.map((fact) => fact.display).join(" · ")}. Sahi hai?`;
}

/**
 * The two chips.
 *
 * CHIPS AND NOT A FREE ANSWER, because the question is genuinely binary and a tap is the
 * cheapest thing a worker on a mid-range Android between shifts can do. {@link readConfirmReply}
 * still reads typed and spoken replies — the chips are the affordance, not the contract.
 */
export const RESUME_CONFIRM_OPTIONS = Object.freeze([
  Object.freeze({
    option_key: "resume_confirm_yes",
    label_text: "Haan, sahi hai",
    value: true,
    implies_skill_id: null,
    is_none_of_above: false,
  }),
  Object.freeze({
    option_key: "resume_confirm_no",
    label_text: "Nahi",
    value: false,
    implies_skill_id: null,
    is_none_of_above: false,
  }),
]);

export type ConfirmReply = "accept" | "decline" | "unclear";

/**
 * What the worker's reply means.
 *
 * ONE LEXICON, NOT A SECOND ONE. `parseAffirmation` is the same parser the 236 boolean pack
 * items use, and it resolves negation itself — so "haan nahi karta" is a NO here for the same
 * reason it is a no there. Writing a local haan/nahi list would be a second yes/no vocabulary
 * free to disagree with the shipped one on the day somebody improves it.
 *
 * `unclear` IS A REAL OUTCOME AND IS NOT AN ACCEPT. A reply this cannot read must never be
 * taken as confirmation: that would write six answers off a sentence nobody understood, which
 * is the worst failure available to this turn. The caller treats it as a decline and lets the
 * ordinary sequence ask the questions properly.
 */
export function readConfirmReply(text: string): ConfirmReply {
  const chip = RESUME_CONFIRM_OPTIONS.find((option) => option.option_key === text.trim());
  if (chip) return chip.value ? "accept" : "decline";

  const parsed = parseAffirmation(text);
  if (parsed === null) return "unclear";
  return parsed.value ? "accept" : "decline";
}

/**
 * The confirmed facts as the interview's own capture shape.
 *
 * `valueRaw` AND `evidence` ARE NULL, and that is the D4 boundary made concrete — see the
 * module docblock. The worker said "haan"; the résumé's sentence is not his and does not enter
 * the transcript projection, so it can never reach the sheet through this door.
 */
export function confirmedValues(facts: readonly ResumeConfirmFact[]): CapturedValue[] {
  return facts.map((fact) => ({
    questionKey: fact.questionKey,
    targetField: fact.targetField,
    valueRaw: null,
    valueNormalized: fact.valueNormalized,
    evidence: null,
  }));
}
