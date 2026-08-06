/**
 * The answer map — the interview's RECORD, as opposed to the transcript, which is its EVIDENCE
 * STORE.
 *
 * THE FRAMING IS THE ENFORCEMENT. Because every answer is normalized at CAPTURE time, a profile
 * can be projected from this map alone when the parse call is down, blocked, or fails its
 * provenance gates. The LLM is an overlay on a complete record, never a dependency of it — which
 * is the whole reason the interview can fail closed instead of failing empty.
 *
 * Every function here is PURE and returns a NEW map. Nothing mutates: the orchestrator's CAS
 * retry re-runs the decision against post-winner state, and that is only safe while the functions
 * it re-runs have no history.
 */

import type { AnswerRecord, AnswerStatus, EvidenceSpan } from "@badabhai/ai-contracts";

/** `question_key` → the single current record for that question. */
export type AnswerMap = Readonly<Record<string, AnswerRecord>>;

/** What the orchestrator knows about a value it wants to write. */
export interface CapturedValue {
  readonly questionKey: string;
  readonly targetField: string | null;
  readonly valueRaw: string | null;
  readonly valueNormalized: unknown;
  readonly evidence: EvidenceSpan | null;
}

/** Build an empty map. Present so callers never hand-roll `{}` and lose the type. */
export function emptyAnswerMap(): AnswerMap {
  return {};
}

/** The contract carries the map as an ARRAY; the engine wants it keyed. */
export function toAnswerMap(records: readonly AnswerRecord[]): AnswerMap {
  const map: Record<string, AnswerRecord> = {};
  // LAST WRITE WINS on a duplicate key. A well-formed state cannot contain one, but state
  // arrives as jsonb from Redis and may have been written by an older build, so the fold has to
  // be defined rather than merely unlikely.
  for (const record of records) map[record.question_key] = record;
  return map;
}

/**
 * Back to the contract's array form, in a STABLE order (by question key).
 *
 * Stability is not cosmetic: the parse call's request is content-hashed for the reply cache, and a
 * map that serialized in a different order each turn would miss every cache hit.
 */
export function toAnswerArray(map: AnswerMap): AnswerRecord[] {
  return Object.keys(map)
    .sort()
    .map((key) => map[key] as AnswerRecord);
}

/**
 * Record an ANSWERED value.
 *
 * A pre-existing value is NOT discarded — it is pushed onto `history` with status `superseded`,
 * newest first. That is load-bearing for the parse call: the transcript holds both the old and the
 * new wording, so without the history the model has to guess which one won.
 *
 * A no-op rewrite (same normalized value) does not grow the history. A worker repeating themselves
 * on a bounded re-ask is not a correction, and a history full of identical entries would make a
 * real correction hard to see.
 */
export function recordAnswer(map: AnswerMap, value: CapturedValue, turn: number): AnswerMap {
  const previous = map[value.questionKey];
  const isRewrite =
    previous !== undefined &&
    previous.status !== "unanswered" &&
    !sameNormalized(previous.value_normalized, value.valueNormalized);

  const history = isRewrite
    ? [
        {
          value_raw: previous.value_raw,
          value_normalized: previous.value_normalized,
          status: "superseded" as const,
          evidence: previous.evidence,
          turn: previous.turn,
        },
        ...previous.history,
      ]
    : (previous?.history ?? []);

  return {
    ...map,
    [value.questionKey]: {
      question_key: value.questionKey,
      target_field: value.targetField,
      value_raw: value.valueRaw,
      value_normalized: value.valueNormalized,
      status: "answered",
      evidence: value.evidence,
      turn,
      history,
    },
  };
}

/**
 * Record a DECLINED question — "nahi pata".
 *
 * A declination is a COMPLETE answer, not a gap: never re-asked, never blocking completion. That
 * is the single most important hard case in the plan, because the alternative is an engine that
 * badgers a worker who has already told it they do not know.
 */
export function recordDeclined(map: AnswerMap, questionKey: string, turn: number): AnswerMap {
  return withStatus(map, questionKey, "declined", turn);
}

/**
 * Record that a question was asked its full budget and never answered.
 *
 * Written when the engine ADVANCES past a question, so `unanswered` always means "we tried and
 * moved on" — distinct from a question with no record at all, which means "not yet reached".
 */
export function recordUnanswered(map: AnswerMap, questionKey: string, turn: number): AnswerMap {
  return withStatus(map, questionKey, "unanswered", turn);
}

function withStatus(
  map: AnswerMap,
  questionKey: string,
  status: AnswerStatus,
  turn: number,
): AnswerMap {
  const previous = map[questionKey];
  return {
    ...map,
    [questionKey]: {
      question_key: questionKey,
      target_field: previous?.target_field ?? null,
      // A declination does not erase a value already captured for this question — the engine
      // does not overwrite an answer with "don't know" arriving later in the same interview.
      value_raw: previous?.value_raw ?? null,
      value_normalized: previous?.value_normalized ?? null,
      status,
      evidence: previous?.evidence ?? null,
      turn,
      history: previous?.history ?? [],
    },
  };
}

function sameNormalized(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameNormalized(item, b[i]));
  }
  return Object.is(a, b);
}

/** Has this question reached a terminal state — answered or explicitly declined? */
export function isSettled(map: AnswerMap, questionKey: string): boolean {
  const status = map[questionKey]?.status;
  return status === "answered" || status === "declined";
}

/**
 * The flattened `captured` projection the v1 contract still carries.
 *
 * Kept populated so every existing reader keeps working across the cutover — deleting it would be
 * a breaking change for a field nothing forced us to remove. Values are stringified because
 * `captured` is `Record<string, string>`; `null` normalized values are skipped rather than
 * rendered as the literal "null".
 */
export function toCapturedProjection(map: AnswerMap): Record<string, string> {
  const captured: Record<string, string> = {};
  for (const key of Object.keys(map).sort()) {
    const record = map[key] as AnswerRecord;
    if (record.status !== "answered") continue;
    const field = record.target_field ?? record.question_key;
    const value = record.value_normalized;
    if (value === null || value === undefined) continue;
    captured[field] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return captured;
}
