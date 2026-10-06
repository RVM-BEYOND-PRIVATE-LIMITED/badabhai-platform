import { canonicalCity } from "@badabhai/profiling-lexicon";

import type { ProfileProjection, ProjectedValue } from "../profiling/answer-map-projector";

/**
 * #2004 — WHAT THE INTERVIEW PATH MAY STORE IN `worker_profiles.rich_profile_draft`.
 *
 * `/profile/extract` certifies its rich draft before it leaves the ai-service (#1788, PR #1989):
 * every free-text label goes through `certified_clean_skill_labels`. The interview path does not
 * call that route. `toExtractionOutput` builds the draft here, in apps/api, out of
 * `projectProfile`'s output, and nothing on this side ran the #1788 certifier over it.
 *
 * THIS MODULE DOES NOT REIMPLEMENT THAT CERTIFIER. The certifier is the ai-service's
 * pseudonymization gateway, and apps/api has no HTTP call into it. So the rule here is the other
 * option #2004 names: STORE ONLY WHAT IS ALREADY CLOSED-SET, OR IS THE WORKER'S OWN ANSWER. A
 * free-text value a model wrote is WITHHELD. Withheld means absent: the field is left out of the
 * projection, so the draft stores its schema default (null or []). It is never masked or rewritten.
 *
 * WHERE A MODEL CAN WRITE A DRAFT VALUE ON THIS PATH (traced, field by field):
 *
 *   1. The `/profile/parse` overlay (`source: "llm_parse"`). The parse model may fill any
 *      crosswalk field the answer map has no value for. Both walls run gates 1-5, but gate 6 (PII)
 *      is a pass-through on this side, and the far side certifies with `certify_value`, not with
 *      the #1788 list certifier (and without the #1989 control-character pre-filter, #1984).
 *        - Free text (`primary_role`, `skills`, `machines`, `controllers`, `certifications`,
 *          `education_level`, `education_field`): WITHHELD.
 *        - `current_city` / `preferred_locations`: kept only when the WHOLE value is one city the
 *          gazetteer knows, and stored as the gazetteer's name. That is a closed set. Gate 3
 *          keeps any non-empty city string, so without this a model city is stored as written.
 *        - Numbers, booleans and the availability enum: KEPT. Gate 3 holds them to a type, a range
 *          or a closed enum on both walls, so they cannot carry free text.
 *
 *   2. The answer map's `trade` (`source: "answer_map"`). The worker can type it
 *      (`qp_universal.primary_trade` is a free-text question), but in an LLM-led interview
 *      `settleFromLlmDraft` also writes it from the Phase A model's `role_label` / `domain_label`.
 *      The stored record does not say which, so it is treated as model-written. It is KEPT only
 *      when it equals the label of the pinned occupation, which comes from the catalogue (a closed
 *      set). Otherwise it is withheld.
 *
 * WHAT IS THE WORKER'S OWN ANSWER, AND KEPT: every other answer-map value. A chip is a pack-
 * authored option value. A typed field went through a capture normalizer. A free-text answer is the
 * worker's own words, trimmed. The one other model write into the map, `settleFromLlmDraft` on
 * `skills`, goes through `matchOptions`, so it can only store a pack option value (closed set).
 *
 * `education` is not listed because nothing on this path writes it: the crosswalk has no
 * `education` destination, so the draft always stores `[]`.
 *
 * PURE: no I/O and no logging. The caller logs the withheld field ids, never the values.
 */

/** Draft fields whose `llm_parse` value is free text a model chose. Withheld whole. */
export const MODEL_FREE_TEXT_DRAFT_FIELDS: ReadonlySet<string> = new Set([
  "primary_role",
  "skills",
  "machines",
  "controllers",
  "certifications",
  "education_level",
  "education_field",
]);

/** Draft fields whose `llm_parse` value is kept only when the city gazetteer recognises it. */
const GAZETTEER_DRAFT_FIELDS: ReadonlySet<string> = new Set([
  "current_city",
  "preferred_locations",
]);

export interface CertifiedInterviewDraft {
  /** The projection's draft with every withheld field removed. Kept values are unchanged. */
  readonly draft: ProfileProjection;
  /** The draft field ids that were withheld or narrowed, sorted. Ids only, never values. */
  readonly withheld: readonly string[];
}

function sameLabel(a: string, b: string): boolean {
  const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
  return norm(a) === norm(b);
}

/**
 * The gazetteer's city name when the WHOLE value is one city, else null.
 *
 * `canonicalCity` searches inside a string, so "Ramesh, Pune" would match on "Pune". Requiring the
 * match to cover the whole trimmed value is what makes this a closed-set check. The canonical name
 * is what gets stored, so the stored string is always the gazetteer's, never the model's.
 */
function wholeCity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const city = canonicalCity(trimmed);
  if (city === null || city.span.start !== 0 || city.span.end !== trimmed.length) return null;
  return city.value;
}

/** A model-typed city value, narrowed to the gazetteer. `null` when nothing survives. */
function gazetteerOnly(value: unknown): unknown {
  if (Array.isArray(value)) {
    const kept = value.map(wholeCity).filter((city): city is string => city !== null);
    return kept.length > 0 ? kept : null;
  }
  return wholeCity(value);
}

/**
 * The draft `toExtractionOutput` may store. See the file header for the field-by-field rule.
 *
 * @param pinnedOccupationLabel The catalogue label of the occupation the interview pinned, or
 *   null when there is no pin. It is the only closed set `primary_role` is checked against.
 */
export function certifyInterviewDraft(
  draft: ProfileProjection,
  pinnedOccupationLabel: string | null,
): CertifiedInterviewDraft {
  const kept: Record<string, ProjectedValue> = {};
  const withheld: string[] = [];

  for (const [field, projected] of Object.entries(draft)) {
    if (projected.source === "llm_parse") {
      if (MODEL_FREE_TEXT_DRAFT_FIELDS.has(field)) {
        withheld.push(field);
        continue;
      }
      if (GAZETTEER_DRAFT_FIELDS.has(field)) {
        const narrowed = gazetteerOnly(projected.value);
        if (narrowed === null) {
          withheld.push(field);
          continue;
        }
        if (JSON.stringify(narrowed) !== JSON.stringify(projected.value)) withheld.push(field);
        kept[field] = { value: narrowed, source: projected.source };
        continue;
      }
      kept[field] = projected;
      continue;
    }

    if (field === "primary_role") {
      const value = projected.value;
      const pinned =
        typeof value === "string" &&
        pinnedOccupationLabel !== null &&
        sameLabel(value, pinnedOccupationLabel);
      if (!pinned) {
        withheld.push(field);
        continue;
      }
    }
    kept[field] = projected;
  }

  return { draft: kept, withheld: withheld.sort() };
}
