import { MAX_ASKS_PER_QUESTION } from "../profiling/next-question";

/**
 * WHICH QUESTION WAS THE ENGINE SERVING WHEN THIS SESSION ENDED — derived, PURE, no I/O.
 *
 * ══ WHY IT HAS TO BE DERIVED AT ALL ════════════════════════════════════════════════════
 *
 * `servedQuestionKey` — the field that literally holds "the question currently on screen" —
 * lives ONLY in the Redis profiling envelope and is deliberately NOT part of
 * `toConversationStatePatch`, so it never reaches `chat_sessions.conversation_state`. It dies
 * with the 24h buffer TTL. `ask_counts` DOES get persisted (the patch projects it), and so
 * does `answer_map`. Those two, diffed against the durable `worker_pack_answer` rows, are
 * what is left — and they are enough.
 *
 * ══ THE THREE FACTS THIS RESTS ON, ALL OWNED BY `next-question.ts` ═════════════════════
 *
 *  1. `ask_counts[k]` increments exactly once each time the engine SERVES question k.
 *  2. The engine never serves a SETTLED question (`isServable` → `isSettled` first), and
 *     it re-serves an already-asked question ONLY when that question is MANDATORY and still
 *     under its ask ceiling. See {@link AdminStuckQuestionCandidate.unservable} — this is the
 *     fact the ranking's second leg turns on, and it is NOT "asks >= ask_ceiling".
 *  3. When the engine ADVANCES PAST the question on screen without it settling, the
 *     orchestrator records an `unanswered` record for that key in the answer map.
 *
 * So the question that was on screen when everything stopped is: asked at least once, not
 * settled, and — crucially — carrying NO `unanswered` record, because nothing ever advanced
 * past it. Fact 3 is the sharp discriminator; facts 1 and 2 are the fallbacks for a session
 * whose checkpoint predates the answer map or lost it.
 *
 * ⚠ FACT 3 HAS A SHAPE THAT MUST NOT BE READ AS A STALL — AND IT IS THE MODAL ONE.
 * `orchestrator.service.ts` records `unanswered` whenever the new decision's `questionKey`
 * differs from what was on screen, and a `close` decision carries `questionKey: null`, which
 * always differs. So on EVERY session the engine closed cleanly, every unsettled asked key
 * ends up engine-advanced-past and there is no candidate the engine was still serving. That
 * is reported as {@link AdminStuckQuestionOutcome} `engine_advanced_past_all` with a NULL
 * `stuck_question` — never as "stuck on" the last question a worker failed on their way to
 * FINISHING the interview. The abandonment path is the contrasting shape: the idle sweep
 * persists the live envelope with `servedQuestionKey` unadvanced, so the question on screen
 * carries no `unanswered` record and is named.
 *
 * ══ THE TIE-BREAK RULE, IN STRICT ORDER ════════════════════════════════════════════════
 *
 * There can be more than one unsettled asked key, so the ranking is total and documented:
 *
 *   1. NOT engine-advanced-past beats engine-advanced-past.
 *      An `unanswered` record is the engine SAYING it moved on. A question it moved on from
 *      is by definition not the one it was still serving. Strongest signal, so it is first.
 *      When EVERY candidate carries it, no question was on screen and the outcome says so
 *      rather than the ranking picking a winner.
 *
 *   2. Provably still SERVABLE beats unknown beats provably UN-servable.
 *      A question the engine can never serve again cannot be the one on screen. Three-valued
 *      because an item that resolves to no pack row answers neither way, and both "unknown
 *      always wins" and "unknown always loses" are a systematic lie about a whole population
 *      — see {@link AdminStuckQuestionResult.unresolved_count}.
 *
 *   3. Higher ask PRESSURE first — `asks / ask_ceiling`, descending.
 *      Among equals, the question the engine pressed hardest on is where the worker
 *      struggled most.
 *
 *   4. Higher raw `asks` first. Breaks a pressure tie between two different ceilings.
 *
 *      ⚠ MEASURED NOTE ON LEGS 3 AND 4. With `MAX_ASKS_PER_QUESTION = 2`, a still-servable
 *      candidate is a MANDATORY item exactly one ask into a ceiling of two, so its pressure is
 *      always 0.5 — these two legs therefore separate nothing at the top of the ranking today,
 *      and only order the un-servable TAIL (which is where "who did they struggle with most" is
 *      a real question). They are kept because they are the legs that start doing work the
 *      moment that constant moves, or when a stored count from an older build sits above the
 *      current ceiling. Do not read a passing rank-1 result as evidence that they ran.
 *
 *   5. Later ENGINE SERVE POSITION first — `(pack_rank, priority_pass, display_order)`
 *      descending. This models `selectItem`'s ACTUAL order rather than `display_order` alone:
 *
 *        pack_rank      the session's pinned OCCUPATION pack is drained before the universal
 *                       tail (`nextQuestion` selects from the occupation pack first), so the
 *                       occupation pack ranks 0 and everything else 1.
 *        priority_pass  within one pack `selectItem` runs THREE passes in strict order —
 *                       mandatory (0), then core-and-never-asked (1), then any-never-asked (2)
 *                       — so a `display_order: 1` non-core item is reached AFTER a
 *                       `display_order: 9` core one. Ordering on `display_order` alone got this
 *                       backwards for most of the corpus.
 *        display_order  the order within one pass, which is the one `selectItem` sorts by.
 *
 *      A HEURISTIC, NOT A FACT, and deliberately rank 5 rather than rank 1: the engine
 *      re-checks the mandatory pass and the whole occupation pack on EVERY turn, so a
 *      mandatory re-ask or a newly-unblocked follow-up can be served after a universal
 *      question. This orders where each candidate FIRST entered the conversation, which is a
 *      good proxy and not a guarantee.
 *
 *   6. `question_key` DESCENDING. Not meaningful; TOTAL. Without a final deterministic leg,
 *      two reads of the same session could disagree, which is the defect `CURRENT_PROFILE_ORDER`
 *      exists to stop one table over.
 *
 * ⚠ WHY PRESSURE IS NOT RULE 1, even though it is the obvious "where did they struggle"
 * metric: a question that burned its whole ask budget has pressure 1.0 and would beat the
 * question actually on screen (typically 0.5) every single time — while being, by rule 2, the
 * one question that provably was NOT on screen. Both readings are useful, so BOTH ship: the
 * ranked `candidates` list carries every unsettled key with its `asks`/`ask_ceiling`/
 * `exhausted`/`unservable` flags, and `stuck_question` answers the narrow question this
 * module is named for.
 *
 * ══ PII ════════════════════════════════════════════════════════════════════════════════
 * Question KEYS, statuses and integers only. In particular this module takes answer-map
 * STATUSES, never answer-map records: `AnswerRecord.value_raw` is "the worker's words,
 * verbatim", so a signature that accepted whole records would put raw PII one `...` away from
 * a response. The narrowing happens in the repository, and the type here makes the wider
 * shape unrepresentable.
 */

/** The answer-map statuses this module can act on. A SUBSET of the contract's `AnswerStatus`. */
export const STUCK_ANSWER_STATUSES = [
  "answered",
  "declined",
  "unanswered",
  "superseded",
] as const;
export type StuckAnswerStatus = (typeof STUCK_ANSWER_STATUSES)[number];

/**
 * The `worker_pack_answer.status` values that mean SETTLED — EXACTLY `isSettled`'s definition
 * in `answer-map.ts`, and the ONE definition of it on this surface.
 *
 * Exported because three readers need to agree: the repository's settled-key read, the
 * per-session `answer_count`, and this module's candidate filter. They agreed by coincidence
 * once and the coincidence was `unanswered` having no writer yet — `packAnswerRowFor` returns
 * null for an unanswered record — which is a property of today's flush, not of the schema.
 */
export const SETTLED_ANSWER_STATUSES = ["answered", "declined"] as const;
export type SettledAnswerStatus = (typeof SETTLED_ANSWER_STATUSES)[number];

/** One pack item, reduced to what the ranking needs. No prompt text — none is required. */
export interface StuckQuestionItem {
  readonly questionKey: string;
  readonly packId: string;
  readonly packVersion: number;
  readonly displayOrder: number;
  readonly maxAsks: number;
  /** `selectItem` pass 1 — the ONLY items the engine ever serves a second time. */
  readonly isMandatory: boolean;
  /** `selectItem` pass 2 — served (once) before the non-core items of the same pack. */
  readonly isCore: boolean;
}

export interface StuckQuestionInput {
  /** `question_key` → times SERVED, straight off `conversation_state.ask_counts`. */
  readonly askCounts: Readonly<Record<string, number>>;
  /**
   * Keys with a terminal `worker_pack_answer` row — status `answered` or `declined` ONLY.
   * That is `isSettled`'s definition, and the two must agree; a test pins them together.
   */
  readonly settledKeys: readonly string[];
  /** `question_key` → status off `conversation_state.answer_map`. STATUSES, never values. */
  readonly answerMapStatuses: Readonly<Record<string, StuckAnswerStatus>>;
  /** Items of the pack versions this session actually used. May be empty. */
  readonly items: readonly StuckQuestionItem[];
  /** `chat_sessions.pack_id` — the pinned OCCUPATION pack, which serves first. */
  readonly pinnedPackId: string | null;
  /** Whether the session had a `conversation_state` at all (vs. an empty one). */
  readonly hasConversationState: boolean;
}

export interface AdminStuckQuestionCandidate {
  question_key: string;
  /** Times the engine served it. */
  asks: number;
  /** The ceiling actually applied: `min(max(1, max_asks), MAX_ASKS_PER_QUESTION)`. */
  ask_ceiling: number;
  /** The item's own `max_asks`, or null when the item could not be resolved in any pack. */
  max_asks: number | null;
  /**
   * `asks >= ask_ceiling`. THE LITERAL CEILING TEST, and NOT the same thing as "the engine
   * can never serve it again" — see {@link unservable}, which is what the ranking uses.
   * Reported because it is the reading `asks`/`ask_ceiling`/`max_asks` invite, and leaving a
   * reader to compute it themselves is how the two get conflated again.
   */
  exhausted: boolean;
  /**
   * THE ENGINE CAN NEVER SERVE THIS AGAIN — `asks >= ask_ceiling || (asks >= 1 && !mandatory)`.
   *
   * `selectItem` has three passes and only the FIRST re-serves: the other two both require
   * `askCount(state, key) === 0`. So for a non-mandatory item ONE ask is permanent, whatever
   * its `max_asks` says. That is not an edge case — 606 of the corpus's 611 items are
   * non-mandatory, and 487 of them declare `max_asks: 1` anyway.
   *
   * NULL when the item resolved to no pack row: `is_mandatory` is then unknown and so is this.
   * Leg 2 ranks `false` (provably servable) above null above `true`, so an unknown neither
   * wins by default nor is buried.
   *
   * NARROWER THAN THE ENGINE ON PURPOSE. `isServable` also consults `min_turn`/`max_turn`,
   * `parent_item_key` and `ask_if`/`skip_if`, all of which depend on conversation state this
   * module deliberately does not have. A `true` here is therefore always right; a `false`
   * means "nothing we can see rules it out".
   */
  unservable: boolean | null;
  /** The answer map holds an `unanswered` record: the engine explicitly moved on. */
  engine_advanced_past: boolean;
  /** `question_pack_item.is_mandatory`, or null when the item could not be resolved. */
  is_mandatory: boolean | null;
  /** `question_pack_item.is_core`, or null when the item could not be resolved. */
  is_core: boolean | null;
  pack_id: string | null;
  pack_version: number | null;
  display_order: number | null;
}

export type AdminStuckQuestionOutcome =
  /** A stuck question was identified. */
  | "resolved"
  /** No `conversation_state` — a v1 interview, or one that never reached the engine. */
  | "no_conversation_state"
  /** State exists but records no asks — the engine never served a pack question. */
  | "no_asks_recorded"
  /** Every asked question settled. A clean completion has no stuck question. */
  | "all_settled"
  /**
   * Questions went unsettled, but the engine had ADVANCED PAST every one of them — so
   * nothing was on screen when the session ended.
   *
   * This is what a completed interview containing a failed question looks like, and it is the
   * MODAL shape: a `close` decision carries `questionKey: null`, which differs from whatever
   * was on screen, so the orchestrator records `unanswered` for it. `stuck_question` is NULL
   * here; the ranked `candidates` still ship, because "which questions did this worker never
   * settle" is exactly the useful question in this shape.
   */
  | "engine_advanced_past_all";

export interface AdminStuckQuestionResult {
  outcome: AdminStuckQuestionOutcome;
  /** Null unless `outcome === "resolved"`. */
  stuck_question: AdminStuckQuestionCandidate | null;
  /** EVERY unsettled asked key, ranked best-first — the tie-break made inspectable. */
  candidates: AdminStuckQuestionCandidate[];
  /** Distinct question keys the engine served at least once. */
  asked_count: number;
  /** How many of those settled (answered or declined). */
  settled_count: number;
  /**
   * How many candidates resolved to NO pack item — their `max_asks`, `is_mandatory`,
   * `is_core` and `display_order` are all unknown, so legs 2 and 5 cannot judge them.
   *
   * Reported rather than absorbed: the caller raises a caveat off it, so an operator can see
   * that the ranking was partly blind instead of reading a confident answer built on nothing.
   * A non-zero value means a key was served out of a pack version this read could not load —
   * a retired version, or a pack the session neither stamped nor pinned.
   */
  unresolved_count: number;
}

/**
 * The effective ask ceiling for one item — a mirror of `askCeiling` in `next-question.ts`,
 * over a nullable `max_asks` instead of a whole `QuestionPackItem`.
 *
 * It imports `MAX_ASKS_PER_QUESTION` rather than restating 2, because the CONSTANT is the
 * part that can move; a test pins this function against the engine's own `askCeiling` across
 * the legal range so the two cannot drift into disagreeing about the same item.
 *
 * A NULL `max_asks` (the item is not in any pack version we could load — a retired version,
 * or a key that outlived its pack) falls back to the engine ceiling. Note that this makes
 * `exhausted` fall the generous way for an unresolved item; `unservable` does NOT follow it
 * there — it reports null, because `is_mandatory` is the input it actually needs and that one
 * has no defensible default.
 */
export function askCeilingOf(maxAsks: number | null): number {
  return Math.min(Math.max(1, maxAsks ?? MAX_ASKS_PER_QUESTION), MAX_ASKS_PER_QUESTION);
}

/**
 * Can the engine ever serve this question again? Null when `isMandatory` is unknown.
 *
 * The engine's own rule, read off `selectItem`: pass 1 re-serves a MANDATORY item while
 * `askCount < askCeiling`; passes 2 and 3 both require `askCount === 0`. So one ask is
 * permanent for anything non-mandatory.
 */
function unservableOf(asks: number, ceiling: number, isMandatory: boolean | null): boolean | null {
  if (asks >= ceiling) return true; // holds whatever `is_mandatory` says
  if (isMandatory === null) return null;
  return asks >= 1 && !isMandatory;
}

/** Leg 2's three-valued order: provably servable (0) < unknown (1) < provably un-servable (2). */
function servabilityRank(unservable: boolean | null): number {
  if (unservable === false) return 0;
  if (unservable === null) return 1;
  return 2;
}

/** Ordering key for rule 5: the pinned occupation pack serves first, everything else after. */
function packRank(packId: string | null, pinnedPackId: string | null): number {
  if (packId === null) return -1; // unresolvable — ranks last within rule 5
  return packId === pinnedPackId ? 0 : 1;
}

/**
 * Rule 5's middle term: which of `selectItem`'s three passes served this item.
 *
 * mandatory 0 → core 1 → everything else 2, matching the `??` chain's order. An unresolved
 * item reports -1 so it sorts EARLIEST (i.e. loses leg 5), the same direction `packRank`
 * sends it.
 */
function priorityPass(candidate: AdminStuckQuestionCandidate): number {
  if (candidate.is_mandatory === null) return -1;
  if (candidate.is_mandatory) return 0;
  return candidate.is_core ? 1 : 2;
}

/**
 * Rank two candidates. Negative ⇒ `a` is the likelier stuck question.
 *
 * Every leg is documented above; this function is the executable copy of that list, in the
 * same order. Do not reorder without moving the prose with it.
 */
function compare(
  a: AdminStuckQuestionCandidate,
  b: AdminStuckQuestionCandidate,
  pinnedPackId: string | null,
): number {
  // 1. not advanced-past first
  if (a.engine_advanced_past !== b.engine_advanced_past) {
    return a.engine_advanced_past ? 1 : -1;
  }
  // 2. provably servable first, then unknown, then provably un-servable
  const servability = servabilityRank(a.unservable) - servabilityRank(b.unservable);
  if (servability !== 0) return servability;
  // 3. higher ask pressure first
  const pressure = b.asks / b.ask_ceiling - a.asks / a.ask_ceiling;
  if (pressure !== 0) return pressure;
  // 4. higher raw asks first
  if (a.asks !== b.asks) return b.asks - a.asks;
  // 5. later engine SERVE position first — (pack, selectItem pass, display_order)
  const rank = packRank(b.pack_id, pinnedPackId) - packRank(a.pack_id, pinnedPackId);
  if (rank !== 0) return rank;
  const pass = priorityPass(b) - priorityPass(a);
  if (pass !== 0) return pass;
  const order = (b.display_order ?? -1) - (a.display_order ?? -1);
  if (order !== 0) return order;
  // 6. total order, so two reads of one session can never disagree
  return a.question_key < b.question_key ? 1 : a.question_key > b.question_key ? -1 : 0;
}

/**
 * Derive the stuck question. Pure: `(input) -> result`. No clock, no DI, no I/O.
 *
 * `askCounts` values are CLAMPED on read the same way `askCount` clamps them in the engine —
 * this data round-trips through jsonb written by older builds, and a stored `-1` or a
 * non-integer must not produce a nonsensical pressure ratio or a negative ceiling.
 */
export function deriveStuckQuestion(input: StuckQuestionInput): AdminStuckQuestionResult {
  const itemByKey = new Map<string, StuckQuestionItem>();
  for (const item of input.items) {
    // First writer wins, and the items arrive ordered by (pack, display_order) — a question
    // key repeated across two pack versions is the SAME question (`question_key` is stable
    // across versions by design), so either row answers "what is its max_asks".
    if (!itemByKey.has(item.questionKey)) itemByKey.set(item.questionKey, item);
  }

  const settled = new Set(input.settledKeys);
  // The answer map is a SECOND authority on settlement, and it is consulted deliberately:
  // an interview that ended without a flush (buffer gone, sweep late) can have a settled
  // record in the checkpoint and no `worker_pack_answer` row. Taking the UNION errs toward
  // "not stuck", which is the honest direction — better to report no stuck question than to
  // accuse a question the worker actually answered.
  for (const [key, status] of Object.entries(input.answerMapStatuses)) {
    if ((SETTLED_ANSWER_STATUSES as readonly string[]).includes(status)) settled.add(key);
  }

  const askedKeys: string[] = [];
  for (const [key, raw] of Object.entries(input.askCounts)) {
    const asks = Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
    if (asks > 0) askedKeys.push(key);
  }

  const askedCount = askedKeys.length;
  const settledCount = askedKeys.filter((k) => settled.has(k)).length;

  const empty = (outcome: AdminStuckQuestionOutcome): AdminStuckQuestionResult => ({
    outcome,
    stuck_question: null,
    candidates: [],
    asked_count: askedCount,
    settled_count: settledCount,
    unresolved_count: 0,
  });

  if (!input.hasConversationState) return empty("no_conversation_state");
  if (askedCount === 0) return empty("no_asks_recorded");

  const candidates: AdminStuckQuestionCandidate[] = askedKeys
    .filter((key) => !settled.has(key))
    .map((key) => {
      const asks = Math.max(0, Math.trunc(input.askCounts[key] as number));
      const item = itemByKey.get(key);
      const maxAsks = item?.maxAsks ?? null;
      const ceiling = askCeilingOf(maxAsks);
      const isMandatory = item?.isMandatory ?? null;
      return {
        question_key: key,
        asks,
        ask_ceiling: ceiling,
        max_asks: maxAsks,
        exhausted: asks >= ceiling,
        unservable: unservableOf(asks, ceiling, isMandatory),
        engine_advanced_past: input.answerMapStatuses[key] === "unanswered",
        is_mandatory: isMandatory,
        is_core: item?.isCore ?? null,
        pack_id: item?.packId ?? null,
        pack_version: item?.packVersion ?? null,
        display_order: item?.displayOrder ?? null,
      };
    })
    .sort((a, b) => compare(a, b, input.pinnedPackId));

  const unresolvedCount = candidates.filter((c) => c.pack_id === null).length;

  if (candidates.length === 0) return empty("all_settled");

  const top = candidates[0] as AdminStuckQuestionCandidate;
  // Leg 1 sorts every not-advanced-past candidate to the front, so a top candidate that IS
  // advanced-past means EVERY candidate is: the engine had moved on from all of them and
  // nothing was on screen. Naming one anyway is the defect this branch exists to prevent.
  const outcome: AdminStuckQuestionOutcome = top.engine_advanced_past
    ? "engine_advanced_past_all"
    : "resolved";

  return {
    outcome,
    stuck_question: outcome === "resolved" ? top : null,
    candidates,
    asked_count: askedCount,
    settled_count: settledCount,
    unresolved_count: unresolvedCount,
  };
}
