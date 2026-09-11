import type { ParsedField, QuestionPackItem } from "@badabhai/ai-contracts";

import { RESUME_PARSE_TARGET_FIELDS } from "./resume-parse-fields";

/**
 * Where a parsed résumé field lands on the form, and — just as importantly — where it does not
 * (ADR-0041 RI-4).
 *
 * WHY THIS IS DATA AND NOT A `switch`. `FIELD_CROSSWALK` exists for exactly this reason and
 * records the lesson in its own docblock: the interview and the extractor drifted apart while
 * nothing connected them, and a `switch` missing a case drops a captured answer SILENTLY — the
 * worker answered, and the field simply never reaches his profile. Here the failure would be
 * quieter still, because a suggestion that never appears looks identical to a résumé that did
 * not mention the thing. As data it can be checked for exhaustiveness, and
 * {@link RESUME_SUGGESTION_TARGETS} is asserted against {@link RESUME_PARSE_TARGET_FIELDS} in
 * the test — so adding a ninth parse field turns the build red rather than quietly extracting
 * something nobody shows the worker.
 *
 * THIS IS NOT `FIELD_CROSSWALK` AND MUST NOT BE FOLDED INTO IT. That table maps the RFS
 * interview vocabulary onto `WorkerProfileDraft` paths; this one maps the RÉSUMÉ vocabulary onto
 * question `target_field`s. They overlap in spelling and diverge in membership — RFS calls
 * machines `tools_equipment`, has no `domain_label` or `role_label` at all, and lands on draft
 * columns rather than pack questions. Reusing it would mean one table answering two questions,
 * which is how the drift it was written to prevent starts again.
 *
 * ── THE TWO NULLS ARE FINDINGS, NOT OVERSIGHTS ───────────────────────────────────────────
 *
 * Written as explicit nulls, the way `FIELD_CROSSWALK` writes `work_history`, so the test can
 * tell a considered omission from a forgotten one.
 */
export const RESUME_SUGGESTION_TARGETS: Readonly<Record<string, string | null>> = Object.freeze({
  // The worker's own words for his trade. `primary_trade` declares `target_field: "trade"`, and
  // this is the single highest-value prefill on the form: it is the question the whole
  // interview otherwise opens with.
  role_label: "trade",

  experience_years: "experience_years",
  current_city: "current_city",
  salary_expected: "salary_expected",
  education_level: "education_level",
  availability: "availability",

  // ROUTER INPUT, NOT A SUGGESTION. `domain_label` is consumed by `routeToTradeForm` to decide
  // WHICH form the worker sees; no question asks for it, and inventing one to give it a home
  // would be a question asked for the machine's benefit rather than the worker's.
  domain_label: null,

  // NO DESTINATION QUESTION EXISTS TODAY, and this is a measured gap rather than a decision.
  // Every trade pack asks for machines as a CLOSED multi-select (`turning_machine` and its
  // siblings), while the parse returns free text a résumé actually printed — "Fanuc Oi-MF",
  // "HMT LB20". Matching those onto option keys means canonicalising machine names, which is
  // `canonicalize_skill`'s job and a phase of its own. Suggesting nothing is the honest state;
  // guessing an option from a partial string match would put a machine on a man's form that his
  // résumé never claimed, which is the D2 failure the whole staging design exists to prevent.
  machines: null,
});

/** What the client renders beside a question. Mirrors the saved-answer value shape exactly. */
export interface ResumeSuggestionValues {
  option_keys: string[];
  text: string | null;
  number: number | null;
  bool: boolean | null;
}

export interface ResumeSuggestion {
  values: ResumeSuggestionValues;
  source: "resume";
  /** The model's own confidence, carried through unaltered. Never a floor, never a filter. */
  confidence: number;
}

/** Why a parsed field produced no suggestion. Counts only — never the value. */
export type SuggestionMissReason =
  | "no_target_question"
  | "question_not_in_pack"
  | "no_matching_option"
  | "wrong_type";

export interface BuiltSuggestions {
  /** Keyed by `question_key`, because that is what the form response is keyed by. */
  readonly byQuestionKey: ReadonlyMap<string, ResumeSuggestion>;
  /** Per-field misses, for the log line and for RI-7's coverage measurement. */
  readonly misses: ReadonlyMap<string, SuggestionMissReason>;
}

/**
 * Turn what survived both walls into what the worker will be shown beside each question.
 *
 * NOTHING HERE WRITES AN ANSWER, and nothing here can. The output is a value object the form
 * response carries; `worker_pack_answer` is only ever written by the worker's own confirmation
 * through `POST /profiling/form/answer` (ruling D2). An import abandoned at this point leaves
 * zero claims behind, which is the property the whole staging design buys.
 */
export function buildSuggestions(
  fields: Readonly<Record<string, ParsedField>>,
  items: readonly QuestionPackItem[],
): BuiltSuggestions {
  const byTargetField = new Map<string, QuestionPackItem>();
  for (const item of items) {
    // FIRST WINS, and the packs make that unambiguous today — but pinned rather than assumed,
    // because a pack that declared one `target_field` twice would otherwise resolve by
    // whichever item the loader happened to return last.
    if (item.target_field !== null && !byTargetField.has(item.target_field)) {
      byTargetField.set(item.target_field, item);
    }
  }

  const byQuestionKey = new Map<string, ResumeSuggestion>();
  const misses = new Map<string, SuggestionMissReason>();

  for (const [fieldId, parsed] of Object.entries(fields)) {
    const target = RESUME_SUGGESTION_TARGETS[fieldId];
    if (target === undefined || target === null) {
      misses.set(fieldId, "no_target_question");
      continue;
    }
    const item = byTargetField.get(target);
    if (item === undefined) {
      // NOT AN ERROR. A worker on the CNC-turning form is served `qp_universal@2` plus his trade
      // pack; a field targeting a question neither contains is simply not asked of him.
      misses.set(fieldId, "question_not_in_pack");
      continue;
    }

    const values = coerce(item, parsed.value);
    if (values === null) {
      misses.set(fieldId, item.options.length > 0 ? "no_matching_option" : "wrong_type");
      continue;
    }
    byQuestionKey.set(item.question_key, {
      values,
      source: "resume",
      confidence: parsed.confidence,
    });
  }

  return { byQuestionKey, misses };
}

/**
 * A parsed value → the shape the client pre-fills with, or `null` when it cannot land.
 *
 * `null` IS A REAL ANSWER HERE and is returned more often than it looks. Two of the four
 * `availability` values the parse may return have no option to land on, and that is a genuine
 * vocabulary difference rather than a bug:
 *
 *   parse returns   pack option (`value_text`)   outcome
 *   ─────────────   ──────────────────────────   ───────────────────────────────────────────
 *   immediate       immediate                    lands
 *   unknown         not_sure → `unknown`         lands
 *   notice_period   15_days AND 1_month          AMBIGUOUS — two options, no way to choose
 *   not_looking     (none)                       the form does not offer it
 *
 * The temptation is to map `notice_period` onto one of the two. Do not: the résumé said "notice
 * period", the form asks how soon he can join, and picking fifteen days over one month invents
 * the answer to a question about the worker's own life. Widening the parse enum to ask the model
 * for the option set directly was considered and REJECTED — `checkTypeRange`'s `availability`
 * branch validates against the INTERVIEW's `AVAILABILITY_VALUES` rather than the supplied target
 * enum, so the résumé route cannot widen its own vocabulary without weakening a gate the
 * interview depends on. RI-7 measures what this costs.
 */
function coerce(item: QuestionPackItem, value: unknown): ResumeSuggestionValues | null {
  const empty: ResumeSuggestionValues = { option_keys: [], text: null, number: null, bool: null };

  if (item.options.length > 0) {
    const wanted = new Set(
      (Array.isArray(value) ? value : [value])
        .filter((entry): entry is string => typeof entry === "string")
        .flatMap((entry) => {
          const bridged = item.target_field === "education_level" ? educationLevel(entry) : null;
          return bridged === null ? [normalise(entry)] : [bridged];
        }),
    );
    if (wanted.size === 0) return null;
    const keys = item.options
      .filter((option) => wanted.has(normalise(String(optionValue(option)))))
      .map((option) => option.option_key);
    return keys.length > 0 ? { ...empty, option_keys: keys } : null;
  }

  if (typeof value === "number" && Number.isFinite(value)) return { ...empty, number: value };
  if (typeof value === "boolean") return { ...empty, bool: value };
  if (typeof value === "string" && value.trim().length > 0) {
    return { ...empty, text: value.trim() };
  }
  return null;
}

/**
 * A printed qualification → the education option the form actually stores, or `null`.
 *
 * WHY A BRIDGE IS NEEDED AT ALL. The parse returns what the document PRINTS, because rule 4 of
 * the prompt forbids computing anything it does not state — so this field arrives as "Diploma in
 * Mechanical Engineering", never as `iti_diploma`. The question is a closed five-option select.
 * Without a bridge the commonest qualification on an Indian trade résumé lands nowhere, and the
 * miss would be invisible: no suggestion looks exactly like a résumé that mentioned no schooling.
 *
 * THE ORDER IS THE WHOLE ALGORITHM, and it runs highest-first so a worker who holds both a
 * diploma and a degree is offered the degree. That ordering is also the trap: "Diploma Mechanical
 * ENGINEERING" contains the word every graduate cue is tempted to match on, which is why the
 * graduate cues are specific credentials (`b.tech`, `bachelor`, `b.sc`) and the bare word
 * "engineering" appears nowhere below. That case is pinned in the test.
 *
 * THIS IS DETERMINISTIC CODE MAKING THE DECISION, which is the rule, not an exception to it. The
 * model is never asked to choose the option key — it reads a line, this table maps it, and
 * anything the table does not recognise produces NO suggestion rather than a guess.
 */
const EDUCATION_CUES: readonly (readonly [RegExp, string])[] = Object.freeze([
  // Degree-level. Specific credentials only — see the "engineering" trap above.
  [/\b(?:m\.?\s?tech|m\.?\s?sc|m\.?\s?a|mba|master'?s?)\b/i, "graduate"],
  [/\b(?:b\.?\s?tech|b\.?\s?e|b\.?\s?sc|b\.?\s?a|b\.?\s?com|bachelor'?s?|graduate|degree)\b/i, "graduate"],
  // ITI and diploma are ONE merged option in the pack (`iti_diploma`) — R11 §3.1 records that
  // the distinction has no representation in the corpus, so this is not losing information the
  // form could have held.
  [/\b(?:iti|i\.t\.i|diploma|polytechnic|ncvt|scvt)\b/i, "iti_diploma"],
  [/\b(?:12th|xii|hsc|intermediate|higher\s+secondary|senior\s+secondary|\+2)\b/i, "12"],
  // NO BARE `x`. It is a Roman ten on a marksheet and an axis on every machining résumé ever
  // written, and this field's value is free text lifted from a document full of both.
  [/\b(?:10th|class\s+x|ssc|sslc|matric(?:ulation)?|high\s+school|secondary)\b/i, "10"],
  [/\b(?:8th|9th|viii|below\s+10th|under\s+matric)\b/i, "below_10"],
]);

function educationLevel(text: string): string | null {
  for (const [pattern, level] of EDUCATION_CUES) {
    if (pattern.test(text)) return level;
  }
  return null;
}

/**
 * The option's stored VALUE, not its key — the same round trip `selectedKeys` does on the saved
 * side, and for the same reason: the two are spelled alike in today's packs and are not required
 * to be. Matching on the key would work by coincidence until the first pack that separates them.
 */
function optionValue(option: QuestionPackItem["options"][number]): string | number | boolean {
  const value = option.value;
  if (typeof value === "string") return value.length > 0 ? value : option.label_text;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return option.label_text;
}

/** Case and surrounding space only. Nothing here should be doing fuzzy matching. */
function normalise(text: string): string {
  return text.trim().toLowerCase();
}
