/**
 * `AnswerMapProjector` — a usable profile from the deterministic answer map ALONE.
 *
 * THIS IS THE FAIL-CLOSED PATH, and it is the reason the whole interview can survive the LLM being
 * down, blocked, or failing every gate. It works because normalization happens at CAPTURE time,
 * not at parse time: `answer-capture.ts` writes `value_normalized` on every turn using Phase 3's
 * normalizers, so by the time the interview ends the map already holds typed values. Nothing has
 * to be re-derived here, and nothing has to be asked of a model.
 *
 * `parse_status = "deterministic_only"` when this is all we have. **The worker still gets a real
 * profile.** The LLM is an overlay that adds coverage regexes cannot reach — never a dependency.
 *
 * THE MAPPING IS NOT LOCAL. Where each RFS answer lands is `FIELD_CROSSWALK` in
 * `@badabhai/profiling-lexicon`, guarded by an exhaustiveness test against the ai-service's own
 * vocabulary. A `switch` here would be a second, unchecked copy of that decision.
 */

import type { AnswerRecord, ParsedField } from "@badabhai/ai-contracts";
import { CROSSWALK_DRAFT_FIELDS, crosswalkFor } from "@badabhai/profiling-lexicon";
import {
  PROFILE_VALUE_SOURCES,
  type AttributeValueKind,
  type ProfileValueSource,
} from "@badabhai/types";

/**
 * Where a projected value came from. Observability, and the audit of what the LLM contributed.
 *
 * RE-EXPORTED, NOT RESTATED. The same vocabulary is a stored column on `worker_attributes`
 * (migration 0071), so a second literal here would be a second chance for "the LLM wrote this" to
 * drift out of agreement with what the database records. The old names are kept so no caller has
 * to change.
 */
export const VALUE_SOURCES = PROFILE_VALUE_SOURCES;
export type ValueSource = ProfileValueSource;

export interface ProjectedValue {
  readonly value: unknown;
  readonly source: ValueSource;
}

/** A partial `WorkerProfileDraft`: draft field id → value, with provenance per field. */
export type ProfileProjection = Readonly<Record<string, ProjectedValue>>;

export const PARSE_STATUSES = ["deterministic_only", "llm_overlay"] as const;
export type ParseStatus = (typeof PARSE_STATUSES)[number];

/**
 * One `target_kind: "attribute"` answer, ready for `worker_attributes`.
 *
 * A SEPARATE OUTPUT FROM `draft`, not a widening of it, because the two have different
 * destinations and different rules. `draft` is the RFS profile the resume is built from;
 * attributes are the matcher's inventory, one row per key, and 77% of the authored corpus is
 * attributes. Merging them would put a `forklift` boolean into a resume field.
 */
export interface ProjectedAttribute {
  readonly attributeKey: string;
  readonly valueKind: AttributeValueKind;
  readonly value: boolean | number | string | readonly string[];
  readonly source: ValueSource;
}

export interface ProjectionResult {
  readonly draft: ProfileProjection;
  readonly parseStatus: ParseStatus;
  /** Draft fields the LLM overlay contributed that the map had nothing for. Ids only. */
  readonly overlayFields: readonly string[];
  /**
   * The attribute answers, keyed and typed. Empty before the corpus had anywhere to put them —
   * which was the state of the world until migration 0071.
   */
  readonly attributes: readonly ProjectedAttribute[];
}

/**
 * The map's live values, keyed by RFS field id.
 *
 * Reads `target_field` and falls back to `question_key`, matching `toCapturedProjection`. Only
 * `answered` records carry a value: a `declined` record is a complete answer for completion
 * purposes but has nothing to put on a resume, and an `unanswered` one is a gap.
 */
function liveValues(answerMap: readonly AnswerRecord[]): Map<string, unknown> {
  const values = new Map<string, unknown>();
  for (const record of answerMap) {
    if (record.status !== "answered") continue;
    if (record.value_normalized === null || record.value_normalized === undefined) continue;
    values.set(record.target_field ?? record.question_key, record.value_normalized);
  }
  return values;
}

/**
 * Write one RFS value onto the draft through the crosswalk.
 *
 * THREE OUTCOMES, and the crosswalk decides which: no entry at all (not an RFS field), a `null`
 * `draftPath` (deliberately not carried — `work_history`, `languages`), or a real destination. A
 * `splitter` entry fans across several draft fields when the caller supplies one, and otherwise
 * keeps the answer on its declared path rather than dropping it.
 */
function assign(
  draft: Record<string, ProjectedValue>,
  fieldId: string,
  value: unknown,
  source: ValueSource,
  split?: (value: unknown) => Record<string, unknown>,
): void {
  const entry = crosswalkFor(fieldId);
  // No entry = not an RFS field. A NULL draftPath = deliberately not carried (work_history,
  // languages). Both write nothing, and the crosswalk records which is which.
  if (!entry || entry.draftPath === null) return;

  if (entry.splitter) {
    const parts = split?.(value);
    if (parts) {
      for (const [draftField, part] of Object.entries(parts)) {
        // A splitter must not be able to WIDEN the set of columns a parse can write to.
        if (CROSSWALK_DRAFT_FIELDS.has(draftField)) draft[draftField] = { value: part, source };
      }
      return;
    }
    // No splitter supplied: keep the answer somewhere reviewable rather than dropping it. The
    // worker answered; a missing splitter is our defect, not theirs.
    draft[entry.draftPath] = { value, source };
    return;
  }

  draft[entry.draftPath] = { value, source };
}

/**
 * THE PRECEDENCE FUNCTION. Written ONCE, here, and nowhere else:
 *
 *     deterministic answer map  >  LLM parse (post-gates)  >  heuristic transcript extractor
 *
 * WRITTEN ONCE IS THE WHOLE POINT. A precedence rule restated in three call sites is a rule that
 * will eventually disagree with itself, and the direction it disagrees in decides whether a model
 * can overwrite what a worker actually said. The gates already discard any parsed value that
 * CONTRADICTS the map; this is the weaker, always-applied rule underneath them — where both have
 * a value, the map's wins, no comparison required.
 *
 * `parseStatus` is `deterministic_only` exactly when the overlay contributed nothing, which is the
 * honest signal for "the LLM was down, blocked, or failed every gate" without this function having
 * to know which.
 */
export function projectProfile(
  answerMap: readonly AnswerRecord[],
  accepted: Readonly<Record<string, ParsedField>> = {},
  options: { readonly split?: (value: unknown) => Record<string, unknown> } = {},
): ProjectionResult {
  const draft: Record<string, ProjectedValue> = {};
  const overlayFields: string[] = [];
  const attributes = new Map<string, ProjectedAttribute>();

  // 1. THE OVERLAY FIRST, so the map can overwrite it. Applying the map first and then guarding
  //    every overlay write would put the precedence rule in two places; letting the winner write
  //    last keeps it in one.
  for (const [fieldId, field] of Object.entries(accepted)) {
    assign(draft, fieldId, field.value, "llm_parse", options.split);
    collectAttribute(attributes, fieldId, field.value, "llm_parse");
  }

  // 2. THE MAP WINS. Unconditionally — no comparison, no merge, no "unless the LLM is more
  //    confident". Confidence is the model's opinion of itself.
  //
  //    The SAME precedence governs attributes, and for the same reason: a later write to the same
  //    key replaces the earlier one, so running the map second is what makes the worker's own
  //    answer beat the model's reading of it.
  const live = liveValues(answerMap);
  for (const [fieldId, value] of live) {
    assign(draft, fieldId, value, "answer_map", options.split);
    collectAttribute(attributes, fieldId, value, "answer_map");
  }

  for (const [draftField, projected] of Object.entries(draft)) {
    if (projected.source === "llm_parse") overlayFields.push(draftField);
  }

  return {
    draft,
    parseStatus: overlayFields.length > 0 ? "llm_overlay" : "deterministic_only",
    overlayFields: overlayFields.sort(),
    attributes: [...attributes.values()].sort((a, b) =>
      a.attributeKey < b.attributeKey ? -1 : a.attributeKey > b.attributeKey ? 1 : 0,
    ),
  };
}

/**
 * Route a NON-RFS answer to `worker_attributes`.
 *
 * HOW IT KNOWS IT IS AN ATTRIBUTE, without being handed the pack: the crosswalk already answers
 * exactly that question. `crosswalkFor` returns an entry for every RFS field id and nothing else —
 * that is what its exhaustiveness test against the ai-service vocabulary guarantees — so "no entry"
 * IS "not an RFS field". Threading `target_kind` down here would be a second, unchecked copy of a
 * fact the crosswalk already holds.
 *
 * A field WITH an entry but a `null` `draftPath` (`work_history`, `languages`) is deliberately not
 * carried onto the resume. It is still RFS, so it does not become an attribute either — it stays
 * exactly as dropped as it was.
 *
 * THE VALUE'S SHAPE PICKS THE COLUMN. `value_kind` is derived from the projected value rather than
 * from `answer_type`, because by this point normalization has already happened and the shape IS the
 * type — and because deriving it here means a new answer type does not need a new case.
 */
function collectAttribute(
  into: Map<string, ProjectedAttribute>,
  fieldId: string,
  value: unknown,
  source: ValueSource,
): void {
  if (crosswalkFor(fieldId)) return;
  const typed = classifyAttributeValue(value);
  // An unrepresentable value is dropped rather than stringified. `worker_attributes` is a matchable
  // inventory; coercing an object into "[object Object]" would put a row there that no query can
  // ever match and no reader can interpret.
  if (typed === null) return;
  into.set(fieldId, { attributeKey: fieldId, ...typed, source });
}

function classifyAttributeValue(
  value: unknown,
): { valueKind: AttributeValueKind; value: boolean | number | string | readonly string[] } | null {
  if (typeof value === "boolean") return { valueKind: "boolean", value };
  if (typeof value === "number" && Number.isFinite(value)) return { valueKind: "number", value };
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? { valueKind: "text", value: trimmed } : null;
  }
  if (Array.isArray(value)) {
    // An EMPTY list is a real answer — "none of these" is not the same as "unanswered", and
    // collapsing them would re-ask a question the worker has already closed.
    const items = value.filter((entry): entry is string => typeof entry === "string");
    return items.length === value.length ? { valueKind: "text_list", value: items } : null;
  }
  return null;
}

/** The draft fields a projection could ever touch — the crosswalk's own set, never a second copy. */
export const PROJECTABLE_DRAFT_FIELDS = CROSSWALK_DRAFT_FIELDS;
