/**
 * The PROFILING ENVELOPE — the deterministic interview's live state, and the seam between the
 * three shapes it has to be.
 *
 * THERE ARE THREE, deliberately, and they are not the same object:
 *
 * 1. **`ProfilingEnvelope` (here)** — what Redis holds between turns. Owned entirely by
 *    `apps/api`; nothing outside this service reads it. It carries the engine's bookkeeping
 *    (`servedQuestionKey`, `abusiveTurns`, `silentTurns`, the CAS `rev`) which no other language
 *    and no persisted row has any business knowing about.
 * 2. **`EngineState` (`next-question.ts`)** — the pure core's view. A strict SUBSET, projected in
 *    by {@link toEngineState}, so a storage-format change can never reach the state machine and
 *    the state machine's tests never construct a Redis object.
 * 3. **`ConversationState` (`@badabhai/ai-contracts`)** — the FROZEN cross-language contract that
 *    lands in `chat_sessions.conversation_state` and feeds the Phase 7 parse call. Projected out
 *    by {@link toConversationStatePatch}.
 *
 * WHY THE ENGINE BOOKKEEPING IS NOT IN THE FROZEN CONTRACT. `ConversationState` is mirrored in
 * `apps/ai-service/app/contracts.py` and changing it is a joint PR by both owners. Adding
 * `abusiveTurns` there would freeze an implementation detail of one service's state machine into a
 * cross-language contract, for a field the parse call cannot use and the ai-service must never
 * write. The seven OIE fields the freeze DID specify — phase, occupation, answer_map, engine_asks,
 * pack_id, pack_version, catalog_version — are all here and all projected out.
 *
 * ⚠ THE FIELD-DROP TRAP. `ChatTranscriptBuffer.narrow()` rebuilds its value FIELD BY FIELD and
 * drops unknown keys, so a field added to this interface but not to {@link narrowProfilingEnvelope}
 * is silently destroyed on the next load — no error, no failing test, just an interview that
 * forgets. The plan names this as the single most likely implementation bug in the whole document.
 * It is closed here by {@link PROFILING_ENVELOPE_KEYS}, whose `satisfies` clause makes an
 * un-narrowed field a TYPECHECK FAILURE rather than a review checklist item.
 */

import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  AnswerRecord,
  AnswerType,
  ConversationState,
  OccupationPin,
  ProfilingPhase,
  QuestionPackOption,
} from "@badabhai/ai-contracts";
import {
  AnswerRecordSchema,
  ANSWER_TYPES,
  OccupationPinSchema,
  PROFILING_PHASES,
  QuestionPackOptionSchema,
} from "@badabhai/ai-contracts";

import { toAnswerArray, toAnswerMap, toCapturedProjection, type AnswerMap } from "./answer-map";
import type { EngineState } from "./next-question";

/**
 * The reply-cache entry — Layer A of the double-submit defence.
 *
 * A mobile client on a flaky 2G connection retries; what it needs is the byte-identical previous
 * response, not a 409 telling it something went wrong when nothing did. The hash binds the entry
 * to (session, rev, text) so a retry of turn 12 can never replay turn 11's answer.
 */
export interface LastTurn {
  /** `sha256(sessionId + rev + text)` — see `inboundHash`. Never the text itself. */
  readonly inboundHash: string;
  /** The reply served, verbatim, including any `{{worker_name}}` placeholder. */
  readonly reply: string;
  /** The question that reply asked, for the client's chip rendering. Null on a close. */
  readonly questionKey: string | null;
  /** ISO timestamp, so the 10 s replay window can be judged without a clock in the core. */
  readonly at: string;
  /**
   * THE REST OF WHAT THE CLIENT DRAWS — and it is cached here because a replay that serves the
   * text without it is not "the byte-identical previous response" this cache promises.
   *
   * The comment on `questionKey` above already said the client needs it "for chip rendering",
   * while the replay path handed back `options: []` and `progress: {0, 0}` — a contradiction the
   * chat surface could absorb (it re-renders a scroller from `suggested_followups`, and a lost
   * progress bar is cosmetic) and the voice form cannot. There, a retried submit over a flaky 2G
   * link is an ORDINARY event, and replaying a `single_select` question with no chips leaves a
   * worker who cannot type looking at a question they have no way to answer.
   *
   * Cached rather than re-derived, deliberately: `replayOf` runs before packs are resolved, and
   * resolving them there would put a Redis read and a possible database round trip on the one
   * path whose entire purpose is to be cheaper than taking the turn again.
   */
  readonly options: readonly QuestionPackOption[];
  readonly progress: { readonly answered: number; readonly total: number };
  /** `why_text` of the question on screen — the ⓘ affordance. Null when it has none. */
  readonly whyText: string | null;
  /** How the question on screen is answered, so the client knows chips from mic. */
  readonly answerType: AnswerType | null;
}

/**
 * The reply-cache key: `sha256(sessionId + rev + text)`.
 *
 * ALL THREE PARTS ARE NECESSARY. Without `sessionId` two workers who send the same word collide;
 * without `rev` a worker who legitimately repeats an answer two turns later gets the older reply
 * replayed at them; without the text any retry at that rev matches, including a different message.
 *
 * A HASH AND NOT THE TEXT, because this is stored in Redis and read into logs and metrics. The
 * worker's actual words live in the transcript, which is the one place they belong (§2).
 *
 * ONLY THE LAST FIELD IS FREE-FORM, which is what makes a plain `:` separator unambiguous: the
 * session id is a fixed-shape UUID and `rev` is digits terminated by the first `:`, so a worker
 * cannot craft a message that re-parses as a different (session, rev) pair. A NUL separator would
 * be marginally tidier and is NOT used — a literal NUL in a source file makes ripgrep treat the
 * whole file as binary and skip it, which silently removes it from every grep-based guard.
 */
export function inboundHash(sessionId: string, rev: number, text: string): string {
  return createHash("sha256").update(`${sessionId}:${rev}:${text}`).digest("hex");
}

/**
 * How long a retry may replay the previous reply instead of taking a turn.
 *
 * Sized for a double-tap and a 2G round trip, not for a worker's considered second thought: past
 * this a repeated message is a real new turn, and replaying would look like the assistant ignoring
 * them.
 */
export const REPLY_CACHE_WINDOW_MS = 10_000;

/**
 * One chip in an outstanding disambiguation offer, WITH the id it resolves to.
 *
 * THE MAP IS HELD SERVER-SIDE, AND THAT IS THE WHOLE DESIGN. When the worker taps "welder", the
 * text that arrives is the label — and resolving it by re-running retrieval against that label
 * would re-enter the same ambiguity the chips exist to settle, potentially landing on a different
 * occupation than the one the chip was built from. The tap is looked up in THIS array instead, so
 * a chip always resolves to exactly the row it was rendered from.
 *
 * `jobDomainId` is null on the "kuch aur" escape — the tap that means "none of these".
 */
export interface OfferedChip {
  readonly label: string;
  readonly jobDomainId: string | null;
  readonly familyId: string | null;
}

/**
 * Everything the deterministic interview needs between turns.
 *
 * ABSENT on a v1 (model-driven) interview, which is why `TranscriptBuffer.profiling` is optional:
 * the orchestrator is built dark and a session that never touches it must round-trip through the
 * buffer byte-identically to before this existed.
 */
export interface ProfilingEnvelope {
  /**
   * The CAS token. Monotonic, incremented by exactly one on every successful write.
   *
   * The whole concurrency guarantee is "a writer that read `rev` may only write at `rev`", which
   * is what turns the old `load → mutate → save` (a silent lost update under a double-submit)
   * into a losable race the loser can detect and re-run.
   */
  readonly rev: number;
  readonly phase: ProfilingPhase;
  readonly occupation: OccupationPin | null;
  /** THE record. `captured` on the buffer is a flattened projection of this. */
  readonly answerMap: readonly AnswerRecord[];
  /** Engine-driven ASKS, not turns — clarifies and re-serves cost a turn and not an ask. */
  readonly engineAsks: number;
  /** `question_key` → times asked. The bounded re-ask's counter. */
  readonly askCounts: Readonly<Record<string, number>>;
  /** The question currently on screen, for the re-serve path. */
  readonly servedQuestionKey: string | null;
  /** CONSECUTIVE clarify re-serves. Reset by any ordinary ask. */
  readonly clarifyCount: number;
  readonly abusiveTurns: number;
  readonly silentTurns: number;
  /** CONSECUTIVE hardship acknowledgements. Bounded so an all-hardship interview still ends. */
  readonly hardshipTurns: number;
  /** True once retrieval has offered choices the worker has not resolved. */
  readonly needsDisambiguation: boolean;
  /**
   * The chips currently on screen and what each resolves to. Empty when no offer is outstanding.
   *
   * Cleared the moment the offer is settled — by a tap, by the escape, or by the offer being
   * abandoned — so a stale array can never resolve a later, unrelated message into an occupation.
   */
  readonly disambiguationOffer: readonly OfferedChip[];
  /**
   * How many turns retrieval has been run and come back with nothing.
   *
   * BOUNDED, because an unbounded identify phase is an interview that never asks a second
   * question. A worker whose trade is genuinely not in the catalogue must still get a profile;
   * after {@link MAX_IDENTIFY_ATTEMPTS} the engine stops trying and runs the universal pack,
   * which is exactly the fallback the universal pack exists for.
   */
  readonly identifyAttempts: number;
  /**
   * The pack pinned WITH the occupation, and immutable for the rest of the conversation.
   *
   * Duplicated from `occupation.pack_id` deliberately (risk #13): a repin replaces `occupation`,
   * but the questions already answered keep pointing at the pack that asked them.
   */
  readonly packId: string | null;
  readonly packVersion: number | null;
  /** Catalogue release retrieval ran against; pins alias resolution mid-flight. */
  readonly catalogVersion: string | null;
  readonly lastTurn: LastTurn | null;
  /** Per-turn orchestrator latency, as a histogram. See {@link TurnLatency}. */
  readonly turnLatency: TurnLatency;
  /**
   * The FAMILY the current pin resolved to — the re-pin comparison key (risk #12).
   *
   * NOT derivable from `occupation`, which carries a `job_domain_id` and no family, and NOT
   * interchangeable with it: the whole reason the ladder resolves families first is that
   * "Welder, Gas" and "Welder, Electric" are a coin flip at occupation level and identical at
   * family level. A re-pin guard comparing job domains would fire on that coin flip and swap a
   * worker's pack for the one it already had.
   */
  readonly occupationFamilyId: string | null;
  /**
   * How many times the occupation has been RE-pinned. The first pin does not count.
   *
   * Bounded by `MAX_OCCUPATION_REPINS`, because an unbounded one lets a worker who keeps naming
   * machines walk the interview through a different pack every turn, answering nothing.
   */
  readonly occupationRepins: number;
}

/**
 * Per-turn orchestrator latency, accumulated as a HISTOGRAM rather than a list (Phase 9).
 *
 * WHY A HISTOGRAM AND NOT PER-TURN EVENTS. The plan's gate is "p95 deterministic turn ≤ 400 ms",
 * which is a percentile over a population — and the obvious way to get one, an event per turn, is
 * the plan's own risk #9: ~12 turns × 1M conversations is 12M rows whose only consumer is a
 * dashboard. Buckets give the same percentile from ONE event per interview, because a percentile
 * over bucketed counts is exactly what an SLO is computed from in the first place.
 *
 * WHY A FIXED SIX FIELDS. The cost of carrying this in the envelope has to be independent of how
 * long the interview runs, or a worker who takes 30 turns pays for the measurement. Five counters
 * and a max are constant no matter the turn count.
 *
 * THE BOUNDARIES BRACKET THE TARGET. 400 ms is the gate, so it is a bucket edge: `le_400` and
 * everything below it is the passing population, and the split at 100/200 is what distinguishes
 * "comfortably inside" from "about to regress". `gt_800` and `max` are the tail the mean would
 * hide — a p50 of 40 ms with one 9-second turn is a broken interview for that worker, and the
 * histogram is what makes them visible.
 */
export interface TurnLatency {
  readonly le_100: number;
  readonly le_200: number;
  readonly le_400: number;
  readonly le_800: number;
  readonly gt_800: number;
  /** The slowest single turn, in ms. The tail the buckets round away. */
  readonly max_ms: number;
}

/** A zeroed histogram. */
export function emptyTurnLatency(): TurnLatency {
  return { le_100: 0, le_200: 0, le_400: 0, le_800: 0, gt_800: 0, max_ms: 0 };
}

/**
 * Fold one turn's duration into the histogram. Pure.
 *
 * A NEGATIVE OR NON-FINITE DURATION IS DROPPED, not clamped into `le_100`. Clock skew between
 * instances is the realistic source, and a bogus 0 ms would make the p95 look better than reality
 * — the one direction a latency metric must never fail in.
 */
export function recordTurnLatency(current: TurnLatency, ms: number): TurnLatency {
  if (!Number.isFinite(ms) || ms < 0) return current;
  const rounded = Math.round(ms);
  const max_ms = Math.max(current.max_ms, rounded);
  if (rounded <= 100) return { ...current, le_100: current.le_100 + 1, max_ms };
  if (rounded <= 200) return { ...current, le_200: current.le_200 + 1, max_ms };
  if (rounded <= 400) return { ...current, le_400: current.le_400 + 1, max_ms };
  if (rounded <= 800) return { ...current, le_800: current.le_800 + 1, max_ms };
  return { ...current, gt_800: current.gt_800 + 1, max_ms };
}

/**
 * Every key of {@link ProfilingEnvelope}, as a value.
 *
 * THE `satisfies` CLAUSE IS THE POINT. `Record<keyof ProfilingEnvelope, true>` fails to compile if
 * a key is missing here, and {@link narrowProfilingEnvelope} is asserted against this object by
 * its round-trip test — so adding a field to the interface without narrowing it breaks the BUILD,
 * not a reviewer's attention. That is the mechanical closure of the plan's ⚠ risk #6.
 */
export const PROFILING_ENVELOPE_KEYS = {
  rev: true,
  phase: true,
  occupation: true,
  answerMap: true,
  engineAsks: true,
  askCounts: true,
  servedQuestionKey: true,
  clarifyCount: true,
  abusiveTurns: true,
  silentTurns: true,
  hardshipTurns: true,
  needsDisambiguation: true,
  disambiguationOffer: true,
  identifyAttempts: true,
  packId: true,
  packVersion: true,
  catalogVersion: true,
  lastTurn: true,
  turnLatency: true,
  occupationFamilyId: true,
  occupationRepins: true,
} satisfies Record<keyof ProfilingEnvelope, true>;

/** A fresh envelope for an interview that has just entered the deterministic engine. */
export function emptyProfilingEnvelope(): ProfilingEnvelope {
  return {
    rev: 0,
    phase: "identify",
    occupation: null,
    answerMap: [],
    engineAsks: 0,
    askCounts: {},
    servedQuestionKey: null,
    clarifyCount: 0,
    abusiveTurns: 0,
    silentTurns: 0,
    hardshipTurns: 0,
    needsDisambiguation: false,
    disambiguationOffer: [],
    identifyAttempts: 0,
    packId: null,
    packVersion: null,
    catalogVersion: null,
    lastTurn: null,
    turnLatency: emptyTurnLatency(),
    occupationFamilyId: null,
    occupationRepins: 0,
  };
}

// ---------------------------------------------------------------------------
// Narrowing — the field-drop trap, closed
// ---------------------------------------------------------------------------

function nonNegativeInt(value: unknown, fallback = 0): number {
  // Redis hands back whatever an older build wrote. A negative ask count would BUY EXTRA ASKS and
  // defeat the re-ask bound outright, so every counter is clamped on the way in as well as on the
  // way out (`askCount` in next-question.ts). Two walls, because the bound is a safety property.
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function narrowAskCounts(value: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (typeof value !== "object" || value === null) return counts;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    counts[key] = Math.max(0, Math.trunc(raw));
  }
  return counts;
}

function narrowAnswerMap(value: unknown): AnswerRecord[] {
  if (!Array.isArray(value)) return [];
  // Per-record, so one unparseable answer costs that answer and not the whole interview. Zod is
  // right here where it is wrong for the buffer as a whole: these records came from a schema, they
  // feed the parse call, and a silently malformed one would reach the LLM as fact.
  const records: AnswerRecord[] = [];
  for (const raw of value) {
    const parsed = AnswerRecordSchema.safeParse(raw);
    if (parsed.success) records.push(parsed.data);
  }
  return records;
}

/**
 * The outstanding chip offer, rebuilt entry by entry.
 *
 * A CHIP WITHOUT A LABEL IS DROPPED, not repaired to "". The label is what the worker taps and
 * what becomes their answer of record verbatim; an empty one would render as a blank button that
 * silently pins a real occupation.
 */
function narrowOffer(value: unknown): OfferedChip[] {
  if (!Array.isArray(value)) return [];
  const chips: OfferedChip[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const v = raw as Record<string, unknown>;
    if (typeof v.label !== "string" || v.label.trim().length === 0) continue;
    chips.push({
      label: v.label,
      jobDomainId: typeof v.jobDomainId === "string" ? v.jobDomainId : null,
      familyId: typeof v.familyId === "string" ? v.familyId : null,
    });
  }
  return chips;
}

function narrowLastTurn(value: unknown): LastTurn | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.inboundHash !== "string" || !v.inboundHash) return null;
  if (typeof v.reply !== "string") return null;
  if (typeof v.at !== "string") return null;
  // THE RENDERABLE HALF IS OPTIONAL ON THE WAY IN AND REQUIRED ON THE WAY OUT.
  //
  // Every entry written before these fields existed is sitting in Redis behind a 24 h TTL right
  // now, and those interviews are live. They narrow to the same empty values the replay path
  // returned unconditionally before this change — so an in-flight session degrades to exactly
  // today's behaviour rather than being discarded to protect a new field.
  //
  // `QuestionPackOptionSchema` rather than a hand-rolled shape check: a chip's `label_text` IS
  // the worker's answer of record when tapped, so the one definition of a valid chip has to be
  // the one the corpus validator and the capture layer already use.
  const options = z.array(QuestionPackOptionSchema).safeParse(v.options);
  const progress = z
    .object({
      answered: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .safeParse(v.progress);
  return {
    inboundHash: v.inboundHash,
    reply: v.reply,
    questionKey: typeof v.questionKey === "string" ? v.questionKey : null,
    at: v.at,
    options: options.success ? options.data : [],
    progress: progress.success ? progress.data : { answered: 0, total: 0 },
    whyText: typeof v.whyText === "string" ? v.whyText : null,
    answerType: isAnswerType(v.answerType) ? v.answerType : null,
  };
}

/** A stored `answer_type` that is still in the contract's closed set. */
function isAnswerType(value: unknown): value is AnswerType {
  return typeof value === "string" && (ANSWER_TYPES as readonly string[]).includes(value);
}

/**
 * Shape-check a stored envelope, rebuilding it field by field.
 *
 * Returns `undefined` for "there is no profiling envelope here" — a v1 interview, or a value that
 * does not look like one at all. That is DISTINCT from a defaulted envelope: handing back a fresh
 * one would restart a deterministic interview at question one while claiming it had never started.
 *
 * A present-but-partial envelope IS repaired to defaults rather than discarded, because the fields
 * that matter for safety (`askCounts`, `engineAsks`, `abusiveTurns`) all fail toward asking LESS.
 */
export function narrowProfilingEnvelope(value: unknown): ProfilingEnvelope | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  // `rev` is the one field whose ABSENCE is meaningful: an object with no rev was not written by
  // this code path, so treating it as an envelope would hand a CAS token to a value that never had
  // one and let the first write win a race it never entered.
  if (typeof v.rev !== "number" || !Number.isFinite(v.rev)) return undefined;

  const phase = PROFILING_PHASES.find((candidate) => candidate === v.phase) ?? "identify";
  const occupation = OccupationPinSchema.safeParse(v.occupation);

  return {
    rev: nonNegativeInt(v.rev),
    phase,
    occupation: occupation.success ? occupation.data : null,
    answerMap: narrowAnswerMap(v.answerMap),
    engineAsks: nonNegativeInt(v.engineAsks),
    askCounts: narrowAskCounts(v.askCounts),
    servedQuestionKey: typeof v.servedQuestionKey === "string" ? v.servedQuestionKey : null,
    clarifyCount: nonNegativeInt(v.clarifyCount),
    abusiveTurns: nonNegativeInt(v.abusiveTurns),
    silentTurns: nonNegativeInt(v.silentTurns),
    hardshipTurns: nonNegativeInt(v.hardshipTurns),
    needsDisambiguation: v.needsDisambiguation === true,
    disambiguationOffer: narrowOffer(v.disambiguationOffer),
    identifyAttempts: nonNegativeInt(v.identifyAttempts),
    packId: typeof v.packId === "string" ? v.packId : null,
    packVersion:
      typeof v.packVersion === "number" && Number.isInteger(v.packVersion) && v.packVersion > 0
        ? v.packVersion
        : null,
    catalogVersion: typeof v.catalogVersion === "string" ? v.catalogVersion : null,
    lastTurn: narrowLastTurn(v.lastTurn),
    turnLatency: narrowTurnLatency(v.turnLatency),
    occupationFamilyId: typeof v.occupationFamilyId === "string" ? v.occupationFamilyId : null,
    occupationRepins: nonNegativeInt(v.occupationRepins),
  };
}

/**
 * A stored histogram, or a zeroed one.
 *
 * ABSENT IS NOT AN ERROR: every envelope written before this field existed has no `turnLatency`,
 * and those interviews are still in flight behind a 24 h TTL. They resume with a zeroed histogram
 * and under-report their own early turns, which is the correct trade — the alternative is
 * discarding a live interview to protect a metric.
 */
function narrowTurnLatency(value: unknown): TurnLatency {
  if (typeof value !== "object" || value === null) return emptyTurnLatency();
  const v = value as Record<string, unknown>;
  return {
    le_100: nonNegativeInt(v.le_100),
    le_200: nonNegativeInt(v.le_200),
    le_400: nonNegativeInt(v.le_400),
    le_800: nonNegativeInt(v.le_800),
    gt_800: nonNegativeInt(v.gt_800),
    max_ms: nonNegativeInt(v.max_ms),
  };
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/**
 * Envelope → the pure core's view.
 *
 * `turn` is passed IN rather than stored: the turn count lives on the transcript buffer and is
 * shared with the v1 path, and a second copy here would be free to disagree with it. The engine's
 * `min_turn`/`max_turn` windows read this, so one authoritative number matters.
 */
export function toEngineState(envelope: ProfilingEnvelope, turn: number): EngineState {
  return {
    phase: envelope.phase,
    turn,
    engineAsks: envelope.engineAsks,
    askCounts: envelope.askCounts,
    answers: toAnswerMap(envelope.answerMap),
    occupation: envelope.occupation,
    servedQuestionKey: envelope.servedQuestionKey,
    clarifyCount: envelope.clarifyCount,
    abusiveTurns: envelope.abusiveTurns,
    silentTurns: envelope.silentTurns,
    hardshipTurns: envelope.hardshipTurns,
    needsDisambiguation: envelope.needsDisambiguation,
  };
}

/** The answer map, keyed, straight off the envelope. */
export function answersOf(envelope: ProfilingEnvelope): AnswerMap {
  return toAnswerMap(envelope.answerMap);
}

/** Write a keyed answer map back, in the contract's stable array order. */
export function withAnswers(envelope: ProfilingEnvelope, answers: AnswerMap): ProfilingEnvelope {
  return { ...envelope, answerMap: toAnswerArray(answers) };
}

/**
 * Envelope → the FROZEN contract's OIE fields, plus the `captured` projection.
 *
 * A PATCH, not a whole `ConversationState`: the v1 fields (`role_family`, `turn_count`,
 * `answered_topics`, …) are owned by the transcript buffer and the ai-service, and rebuilding them
 * here would give two writers one field. The caller merges this over the state it already has.
 *
 * `captured` STAYS POPULATED, and that is the backward-compatibility guarantee of the whole
 * cutover: every existing reader of the flattened map keeps working while `answer_map` becomes the
 * record underneath it.
 */
export function toConversationStatePatch(
  envelope: ProfilingEnvelope,
): Pick<
  ConversationState,
  | "phase"
  | "occupation"
  | "answer_map"
  | "engine_asks"
  | "pack_id"
  | "pack_version"
  | "catalog_version"
  | "captured"
  | "ask_counts"
  | "clarify_count"
> {
  return {
    phase: envelope.phase,
    occupation: envelope.occupation,
    answer_map: [...envelope.answerMap],
    engine_asks: envelope.engineAsks,
    pack_id: envelope.packId,
    pack_version: envelope.packVersion,
    catalog_version: envelope.catalogVersion,
    captured: toCapturedProjection(toAnswerMap(envelope.answerMap)),
    ask_counts: { ...envelope.askCounts },
    clarify_count: envelope.clarifyCount,
  };
}
