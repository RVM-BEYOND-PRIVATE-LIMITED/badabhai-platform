import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { WorkerProfile } from "@badabhai/db";
import { isAbusive } from "@badabhai/profiling-lexicon";
import type { CompanionRecentTurn } from "@badabhai/ai-contracts";
import type {
  CompanionV2ConfidenceBucket,
  CompanionV2Intent,
  CompanionV2IntentSourceV3,
  CompanionV3Intent,
  CompanionV3Outcome,
} from "@badabhai/types";
import { SERVER_CONFIG } from "../../config/config.module";
import { AiCostRecorder } from "../../ai/ai-cost-recorder.service";
import { AiService } from "../../ai/ai.service";
import type { RequestContext } from "../../common/request-context";
import { EventsService } from "../../events/events.service";
import type { CompanionMessageDto, CompanionTurn } from "../chat-companion.dto";
import { companionBrainOn, companionRoutePrecedenceOn } from "../companion-brain-switch";
import {
  V2_CAREER_ASK,
  V2_CLARIFY,
  V2_EDIT_ASK,
  V2_IN_FLIGHT,
  V3_GREETING,
  type CopyPair,
} from "../companion-replies";
// VALUE import: a constructor parameter (Nest resolves it by its class token).
import {
  CompanionBrain,
  distressTurn,
  type BrainFacts,
  type BrainInput,
  type BrainTurn,
} from "./companion-brain";
import { CompanionConversationMemory } from "./companion-conversation-memory";
import { taskChipLabel, type CompanionTaskChipIntent } from "./companion-task-chips";
import { taskChips, v2CooldownTurn, v2CopyTurn } from "./companion-v2-compose";
import { FaltuStore } from "./faltu.store";
import type { HandlerResult } from "./handlers/handler";
import { CompanionHandlerRegistry } from "./handlers/registry";
import { PendingIntentStore, type PendingIntent } from "./pending-intent.store";
import { CompanionTurnReplayStore } from "./turn-replay.store";

/** The reply stored as the companion's side of a memory turn — a context line, not a record. */
const MEMORY_REPLY_MAX = 1_000;

/**
 * The classify contract's text bound (contracts §2.1, `CompanionClassifyInputSchema.text`) — and
 * the memory store's per-turn bound, which is the same number. The API accepts a 4000-char
 * message, so the classifier sees its first 1000: a longer text would be a 422, i.e. `unclear`
 * for a message that was perfectly clear. The HANDLER still gets the whole text — masked, or raw
 * while `AI_RAW_PII_ENABLED` is on (the edit-parse and career contracts take 4000). Pinned
 * against the schema in the orchestrator test.
 */
export const CLASSIFY_TEXT_MAX = 1_000;

/**
 * A TAPPED TASK CHIP NAMES A TASK, NOT A REQUEST. "Resume badlo" says no change and "Career ki
 * baat" asks no question, so neither label is ever sent to a model: the tap is answered with the
 * fixed line that asks for the missing part. "Naya resume" IS the whole request — its handler
 * serves the redo menu with no model — so it is the one chip that reaches a handler.
 */
const TASK_CHIP_ASK: Readonly<Partial<Record<CompanionTaskChipIntent, CopyPair>>> = {
  edit_resume: V2_EDIT_ASK,
  career_talk: V2_CAREER_ASK,
};

/** A turn about to be served, with the facts its memory append and its v4 event need. */
interface ServedTurn {
  turn: CompanionTurn;
  intentSource: CompanionV2IntentSourceV3;
  v2Intent: CompanionV3Intent | null;
  confidenceBucket: CompanionV2ConfidenceBucket | null;
  outcome: CompanionV3Outcome;
  memoryPair: { workerText: string; reply: string } | null;
  /** ADR-0055 — what the free-chat brain decided; absent on every v2-path turn (all null on the event). */
  brain?: BrainFacts;
}

/** The v4 event's brain fields on a turn the brain did not decide: nothing, and no tiles. */
const NO_BRAIN_FACTS: BrainFacts = {
  freeCategory: null,
  resumeAction: null,
  refusalTopic: null,
  replyLanguage: null,
  newsOutcome: null,
  newsSourceCount: 0,
};

/**
 * Steps 0-2 of a classified route (`prepare`): the abuse lexicon answered it, the gateway refused it,
 * or the message is ready for a classifier — the gateway's copy and the memory.
 */
type Prepared =
  | { readonly kind: "lexicon"; readonly out: ServedTurn }
  | { readonly kind: "blocked" }
  | {
      readonly kind: "ready";
      readonly promptText: string;
      readonly recent: CompanionRecentTurn[];
    };

/** A served v1-miss turn, and whether a retry of the same submission may be answered with it. */
interface RoutedTurn {
  readonly turn: CompanionTurn;
  readonly replayable: boolean;
}

/**
 * `text` cut to at most `max` UTF-16 units without splitting a surrogate pair — so the result
 * is within the bound whether the far side counts code units (Zod) or code points (Pydantic).
 */
function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * THE V2 TURN PIPELINE (ADR-0046 §2.1) — reached ONLY while `CHAT_COMPANION_V2_ENABLED` is on,
 * from four places in `ChatCompanionService.message`: an OPEN task-chip tap (`handleTaskChip`,
 * before v1), a free-text message during a faltu cool-down (`handleCooldown`, before v1), a
 * v1 MISS (`handleMessage`), and — while `CHAT_COMPANION_V2_ROUTE_PRECEDENCE_ENABLED` is on
 * (TD146, WP6) — a pending intent after a chip tap or an edit-precheck hit (`handleDirectIntent`,
 * before v1, with NO classifier call). A v1 resolver hit never arrives here: it is served by v1
 * with zero model calls and records v1's own `chat.companion_turn_served`, not the v2 event.
 *
 * THE ORDER IS THE PRIVACY ORDER, and it fails closed at every step:
 *   0. a RETRIED submission (same `submission_id`) is answered with the turn already served —
 *      nothing below runs again (no model call, no strike, no memory append, no second event) —
 *      unless that turn failed closed, which is never kept, so the retry is processed afresh;
 *   1. the ABUSE LEXICON (P2, only while the faltu flag is on) — deterministic, local, and
 *      BEFORE the gateway: a message it flags reaches no provider, no model, no memory;
 *   2. pseudonymize the message through the gateway — a blocked or unreachable gateway serves the
 *      clarify line WITHOUT a classifier call and stores nothing. While `AI_RAW_PII_ENABLED` is
 *      on this step is skipped and steps 3-6 carry the raw text instead (see `promptTextOf`);
 *   3. read the memory (pseudonymized; raw for turns stored while the flag was on), last two turns;
 *   4. classify the first `CLASSIFY_TEXT_MAX` chars — null, blocked or a schema miss is
 *      `unclear`; a confidence below the configured floor is `unclear` too;
 *   5. the registry picks the handler from the closed intent set;
 *   6. append the pair to memory — the step-2 text, so raw while the flag is on — never for a
 *      message the classifier called `faltu` (abuse the lexicon missed is still never model
 *      context: it is kept only in the worker's own 7-day history, ADR-0056);
 *   7. emit `chat.companion_turn_served_v4` — ids, counts and closed enums only.
 *
 * ADR-0055 (#2275) — THE FREE-CHAT BRAIN. While `companionBrainOn` (the kill switch
 * `CHAT_FREE_CHAT_DISABLED` off — the production default), steps 4-5 are the profiling free chat's
 * classifier and its per-category answers (`CompanionBrain`), on the same gateway text and the same
 * memory; steps 0-3 and 6-7 are unchanged. With the kill switch on, steps 4-5 are the v2
 * classifier and registry exactly as before. Both paths emit the v4 event; the brain's facts ride
 * it, and on a v2-path turn they are null.
 *
 * The model NEVER decides anything but the intent: handlers are deterministic, and the only
 * handler that can cause a write is the edit one, which still requires the worker's Haan.
 */
@Injectable()
export class CompanionV2Orchestrator {
  private readonly logger = new Logger(CompanionV2Orchestrator.name);
  /**
   * #2297 — the turns whose pair went into the memory (`memoryPair` set), by IDENTITY of the turn
   * object this class returned. Read once by the service when it stores the turn, to mark the
   * lines a later model call may read; a WeakSet, so nothing outlives the turn.
   */
  private readonly remembered = new WeakSet<CompanionTurn>();
  /**
   * #2297 — the ECHOES this class returned, by identity: the in-flight line answering a duplicate
   * while the first request still runs, and the replay of a turn already served. Neither is a turn
   * of its own, so neither is ever written to the stored conversation.
   */
  private readonly echoes = new WeakSet<CompanionTurn>();

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly ai: AiService,
    // #2297 — the recent turns a model reads: the stored conversation on the brain, Redis otherwise.
    private readonly memory: CompanionConversationMemory,
    private readonly registry: CompanionHandlerRegistry,
    private readonly events: EventsService,
    private readonly cost: AiCostRecorder,
    private readonly faltu: FaltuStore,
    private readonly replays: CompanionTurnReplayStore,
    private readonly pending: PendingIntentStore,
    // ADR-0055 — the free-chat brain, reached only while `companionBrainOn`.
    private readonly brain: CompanionBrain,
  ) {}

  /**
   * ADR-0055 — THE DISTRESS WORD LIST HIT, before the v1 resolver (the service's gate; the free
   * chat's own list, `matchesDistress`). The Tele-MANAS line alone — no chips — and the v4 event
   * with `intent_source: "lexicon"`. No gateway, no model, no memory: a deterministic answer to a
   * message that is never model context, the way the abuse lexicon's is not — it is stored only for
   * the worker's own 7-day history (ADR-0056), never replayed to a model.
   */
  async handleDistress(
    workerId: string,
    dto: CompanionMessageDto,
    ctx: RequestContext,
    now: Date,
  ): Promise<CompanionTurn> {
    return this.finish(workerId, ctx, dto, now, {
      turn: distressTurn(),
      intentSource: "lexicon",
      v2Intent: "distress",
      confidenceBucket: null,
      outcome: "served",
      memoryPair: null,
    });
  }

  /**
   * #2287 (owner ruling 2026-10-15) — A BARE GREETING on the brain (the service's
   * `isBareGreeting`): the fixed `V3_GREETING` line with the task chips the clarify line carries,
   * and the v4 event as a deterministic route (`intent_source: "v1_deterministic"`, `v2_intent:
   * "casual"`). No gateway, no model, no memory.
   *
   * REPLAY-SAFE BY DETERMINISM, so it needs no replay shell: a resent submission is answered with
   * the same fixed turn (nothing here varies, counts or is stored), and the event is keyed on the
   * submission id, so the spine keeps one row for it.
   */
  async handleGreeting(
    workerId: string,
    dto: CompanionMessageDto,
    ctx: RequestContext,
    now: Date,
  ): Promise<CompanionTurn> {
    return this.finish(workerId, ctx, dto, now, {
      turn: v2CopyTurn(V3_GREETING, taskChips(this.config)),
      intentSource: "v1_deterministic",
      v2Intent: "casual",
      confidenceBucket: null,
      outcome: "served",
      memoryPair: null,
    });
  }

  /**
   * When the worker's faltu cool-down ends, or null. The SERVICE's gate asks this before the
   * v1 resolver (phase-2 order: chip keys → cool-down → v1 → lexicon → classifier); the
   * orchestrator only lends the store, because the gate must run where the v1 branch is.
   */
  async cooldownUntil(workerId: string, now: Date): Promise<string | null> {
    return this.faltu.cooldownUntil(workerId, now);
  }

  /**
   * A free-text message the cool-down gate refused (P2, O11): the fixed line, the open chips,
   * `cooldown_until`, and a v2 event with `intent_source: "guard"`. No gateway, no model, no
   * memory — nothing about the message is read, stored or echoed.
   */
  async handleCooldown(
    workerId: string,
    dto: CompanionMessageDto,
    ctx: RequestContext,
    now: Date,
    until: string,
  ): Promise<CompanionTurn> {
    return this.finish(workerId, ctx, dto, now, {
      turn: v2CooldownTurn(until, taskChips(this.config)),
      intentSource: "guard",
      v2Intent: null,
      confidenceBucket: null,
      outcome: "cooldown",
      memoryPair: null,
    });
  }

  /**
   * A TASK-CHIP TAP (P2) — deterministic routing for an OPEN `companion_task:*` chip (the
   * service recognises a chip only while its phase flag is on), before the cool-down gate and
   * before v1 (see `companion-task-chips.ts` for why v1 cannot be trusted with these labels).
   * No classifier and no model run: an edit or career tap is answered with its fixed ask line
   * (`TASK_CHIP_ASK`), and the new-résumé tap goes to its handler with the chip's SERVER-AUTHORED
   * label — never the bytes the app posted, which only matched it after normalization. The v2
   * event records `intent_source: "v1_deterministic"` (the deterministic chip route; the name
   * predates it) and the chip's intent. No memory pair is stored: a tap adds no worker text.
   */
  async handleTaskChip(
    workerId: string,
    profile: WorkerProfile,
    dto: CompanionMessageDto,
    intent: CompanionTaskChipIntent,
    ctx: RequestContext,
    now: Date,
  ): Promise<CompanionTurn> {
    const ask = TASK_CHIP_ASK[intent];
    const handled: HandlerResult =
      ask !== undefined
        ? { turn: v2CopyTurn(ask, taskChips(this.config)), outcome: "served" }
        : await this.registry.resolve(intent).handle({
            workerId,
            profile,
            text: taskChipLabel(intent),
            // A tap carries no new context; the handler input still carries what the
            // conversation already has, exactly as on the classify path.
            recentTurns: await this.memory.read(workerId),
            ctx,
            now,
            // A chip tap has no submission id: the app posts the label, not a message send.
            submissionId: null,
          });
    // WP6: the tap remembers the task for the NEXT message (edit/career), or clears a stale one
    // (any other task chip). Best-effort — the tap's own answer is already in hand either way.
    if (this.routePrecedenceOn()) {
      // ADR-0055 R1: while the brain is on it answers career talk itself (the free-chat reply, which
      // supersedes the v2 career handler on this screen), so only the edit task is remembered.
      const remembers =
        intent === "edit_resume" || (intent === "career_talk" && !companionBrainOn(this.config));
      if (remembers) {
        await this.pending.set(workerId, intent);
      } else {
        await this.pending.clear(workerId);
      }
    }
    return this.finish(workerId, ctx, dto, now, {
      turn: handled.turn,
      // V3 (TD150/WP8): an exact chip tap is its own source value. `v1_deterministic` now means
      // only the OTHER deterministic pre-classifier routes (WP6's pending intent / pre-check).
      intentSource: "chip",
      v2Intent: intent,
      confidenceBucket: null,
      outcome: handled.outcome,
      memoryPair: null,
    });
  }

  /**
   * WP6's route precedence (TD146): its own default-off flag, or the free-chat brain (ADR-0055 R1).
   * The service reads the same definition, so the pending intent is set exactly while it is taken.
   */
  private routePrecedenceOn(): boolean {
    return companionRoutePrecedenceOn(this.config);
  }

  /** Consume the worker's pending intent (one-shot). Null when absent, expired or unreadable. */
  async takePendingIntent(workerId: string): Promise<PendingIntent | null> {
    return this.pending.take(workerId);
  }

  /** Drop a pending intent because another chip was tapped. Best-effort; never throws. */
  async clearPendingIntent(workerId: string): Promise<void> {
    await this.pending.clear(workerId);
  }

  /**
   * A DETERMINISTIC v1-BYPASS ROUTE (WP6): a pending intent left by a chip tap, or an edit
   * pre-check hit. The handler runs with NO classifier call; the gateway still masks the text
   * first (privacy is not skipped by routing), and the abuse lexicon runs first exactly as it
   * does on the v1-miss path, so an abusive message costs no model call on this route either.
   * The memory pair and the v2 event are written exactly as a classified turn's — except
   * `intent_source: "v1_deterministic"` (it IS a deterministic pre-v1 route) and no confidence
   * bucket (no classifier answered). A gateway refusal fails closed to the clarify line.
   *
   * IDEMPOTENT ON THE SUBMISSION, like the other two routes (ADR-0055 security note, 2026-10-15).
   * With the brain on this route runs in production for every edit phrasing and pending intent, so
   * it shares their replay shell (`onceServed`): a resent `submission_id` is answered with the turn
   * already served — no second lexicon strike, no second edit parse, no second proposal card — and
   * a duplicate that arrives while the first still runs gets the in-flight line. Steps 0-2 are the
   * shared `prepare`, so this route and the classified ones cannot differ in what reaches a model.
   */
  async handleDirectIntent(
    workerId: string,
    profile: WorkerProfile,
    dto: CompanionMessageDto,
    intent: PendingIntent,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<CompanionTurn> {
    return this.onceServed(workerId, dto, () =>
      this.routeDirect(workerId, profile, dto, intent, ctx, now),
    );
  }

  /** The direct route itself: steps 0-2, then the intent's own handler (no classifier). */
  private async routeDirect(
    workerId: string,
    profile: WorkerProfile,
    dto: CompanionMessageDto,
    intent: PendingIntent,
    ctx: RequestContext,
    now: Date,
  ): Promise<RoutedTurn> {
    const prepared = await this.prepare(workerId, profile, dto, ctx, now);
    if (prepared.kind === "lexicon") return this.routed(workerId, ctx, dto, now, prepared.out);
    if (prepared.kind === "blocked")
      return this.routed(workerId, ctx, dto, now, this.clarifyFallback());
    const handled = await this.registry.resolve(intent).handle({
      workerId,
      profile,
      text: prepared.promptText,
      recentTurns: prepared.recent,
      ctx,
      now,
      submissionId: dto.submission_id ?? null,
    });
    return this.routed(workerId, ctx, dto, now, {
      turn: handled.turn,
      intentSource: "v1_deterministic",
      v2Intent: intent,
      confidenceBucket: null,
      outcome: handled.outcome,
      memoryPair: {
        workerText: clipText(prepared.promptText, CLASSIFY_TEXT_MAX),
        reply: handled.turn.reply,
      },
    });
  }

  /**
   * The gateway refused or was unreachable: the clarify line, as a FAIL-CLOSED turn (never kept for
   * a retry, never model context; it is stored only for the worker's own 7-day history, ADR-0056).
   * One definition for every route that reaches the gateway.
   */
  private clarifyFallback(): ServedTurn {
    return {
      turn: v2CopyTurn(V2_CLARIFY, taskChips(this.config)),
      intentSource: "fallback",
      v2Intent: null,
      confidenceBucket: null,
      outcome: "clarify",
      memoryPair: null,
    };
  }

  /**
   * A v1 MISS. A retried submission is answered from the replay cache FIRST — before the lexicon,
   * so a retried abusive message is not a second strike — and a freshly served turn is kept there
   * for its own retry. Without a `submission_id` (an older client) there is nothing to key on and
   * the message is simply processed.
   *
   * A FAIL-CLOSED TURN IS NEVER KEPT (`intent_source: fallback` — the gateway or the classifier
   * was unreachable, blocked or off-contract). A retry is most often BECAUSE the AI path was slow,
   * so pinning its clarify line for the replay TTL would answer every retry with the failure after
   * the AI recovered. That path has little to dedupe: no strike, no handler model call, and the
   * event is deduped on the submission id (so the spine keeps the FIRST attempt's `fallback`
   * row). The one repeat is memory: a classifier failure still stores the pair, so a
   * processed retry stores the worker's line twice — context only, capped at `MEMORY_TURNS`.
   */
  async handleMessage(
    workerId: string,
    profile: WorkerProfile,
    dto: CompanionMessageDto,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<CompanionTurn> {
    return this.onceServed(workerId, dto, () => this.route(workerId, profile, dto, ctx, now));
  }

  /**
   * ADR-0055 R2 (owner ruling 2026-10-15) — a TYPED message v1 would answer with its jobs list,
   * while the brain is on. The same shell as {@link handleMessage} (replay, in-flight claim) and the
   * same steps 0-2 (lexicon, gateway, memory), then the brain's ONE classify (`routeJobsWord`).
   *
   * NULL MEANS "v1's JOBS ANSWER": the brain had nothing better to say (`jobs`, `unclear`, below the
   * floor, an unavailable classifier), the gateway refused the message, or the brain threw. The
   * service then serves TODAY's job chips and records v1's own event; no memory, no v4 event, and
   * nothing is kept for a retry (a retry of a deferred message classifies again). Every other
   * verdict is a brain turn, recorded on the v4 event like any v1 miss.
   */
  async handleJobsMessage(
    workerId: string,
    profile: WorkerProfile,
    dto: CompanionMessageDto,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<CompanionTurn | null> {
    return this.onceServed(workerId, dto, () => this.routeJobs(workerId, profile, dto, ctx, now));
  }

  /**
   * THE REPLAY SHELL around one classified route (see {@link handleMessage} for why each step is
   * there). A route that returns null served nothing here — the caller answers — so nothing is
   * kept for a retry.
   */
  private async onceServed(
    workerId: string,
    dto: CompanionMessageDto,
    run: () => Promise<RoutedTurn>,
  ): Promise<CompanionTurn>;
  private async onceServed(
    workerId: string,
    dto: CompanionMessageDto,
    run: () => Promise<RoutedTurn | null>,
  ): Promise<CompanionTurn | null>;
  private async onceServed(
    workerId: string,
    dto: CompanionMessageDto,
    run: () => Promise<RoutedTurn | null>,
  ): Promise<CompanionTurn | null> {
    const submissionId = dto.submission_id;
    if (submissionId === undefined) return (await run())?.turn ?? null;

    const replayed = await this.replays.read(workerId, submissionId);
    if (replayed !== null) return this.echo(replayed);

    // TD150/WP8 — THE IN-FLIGHT CLAIM. A duplicate that arrives WHILE the first request still
    // runs has no replay to read yet; without this it would run the whole pipeline again (a
    // second classify, a second strike, a second edit parse/card). The claim is one Redis SET NX
    // EX for the turn's duration: `held` answers the fixed V2_IN_FLIGHT line — no model call, no
    // strike, no memory, no event (the first request owns the turn) — and the claim is released
    // in the finally whether the route succeeded or threw. A Redis refusal fails open: the
    // duplicate is processed as before, exactly like an unreadable replay cache.
    const claim = await this.replays.claim(workerId, submissionId);
    if (claim === "held") return this.echo(v2CopyTurn(V2_IN_FLIGHT, taskChips(this.config)));
    try {
      const routed = await run();
      if (routed === null) return null;
      if (routed.replayable) await this.replays.remember(workerId, submissionId, routed.turn);
      return routed.turn;
    } finally {
      await this.replays.release(workerId, submissionId);
    }
  }

  /**
   * STEPS 0-2 OF EVERY CLASSIFIED ROUTE — the abuse lexicon, the gateway, the memory — in the
   * privacy order (class header). Shared by the v1-miss route and the jobs-word route (ADR-0055 R2),
   * so the two can never differ in what reaches a model or Redis.
   */
  private async prepare(
    workerId: string,
    profile: WorkerProfile,
    dto: CompanionMessageDto,
    ctx: RequestContext,
    now: Date,
  ): Promise<Prepared> {
    // 0. THE ABUSE LEXICON (P2, O11), only while the faltu phase is on. It runs BEFORE the
    //    gateway because nothing crosses a boundary on this path: the answer is fixed copy and
    //    a strike count. A flagged message therefore costs no gateway hop and no model call,
    //    and — because the finish below passes no memory pair — it is never model context: it is
    //    stored only for the worker's own 7-day history (ADR-0056), never replayed to a model.
    if (this.config.CHAT_COMPANION_V2_FALTU_ENABLED && isAbusive(dto.text)) {
      const handled = await this.registry.resolve("faltu").handle({
        workerId,
        profile,
        text: "",
        recentTurns: [],
        ctx,
        now,
        submissionId: dto.submission_id ?? null,
      });
      return {
        kind: "lexicon",
        out: {
          turn: handled.turn,
          intentSource: "lexicon",
          v2Intent: "faltu",
          confidenceBucket: null,
          outcome: handled.outcome,
          memoryPair: null,
        },
      };
    }

    // 1. THE GATEWAY FIRST (see `promptTextOf`). `null` is the AI service being unreachable or
    //    the gateway refusing. Neither reaches a model or Redis; the caller decides the answer.
    const promptText = await this.promptTextOf(dto.text, ctx);
    if (promptText === null) return { kind: "blocked" };

    // 2. MEMORY — pseudonymized at rest, raw while `AI_RAW_PII_ENABLED` is on. The classifier sees
    //    at most the last two turns; the FULL read (up to MEMORY_TURNS) rides the handler input,
    //    because the Phase 3 career answer reads up to six and a second Redis hop would buy nothing.
    return { kind: "ready", promptText, recent: await this.memory.read(workerId) };
  }

  /**
   * ADR-0055 R2 — the jobs-word route: steps 0-2, then the brain's `routeJobsWord`. Null (v1's jobs
   * answer) when the gateway refused the message, when the brain defers, or when it throws — a
   * jobs message never ends worse than v1 would have answered it.
   */
  private async routeJobs(
    workerId: string,
    profile: WorkerProfile,
    dto: CompanionMessageDto,
    ctx: RequestContext,
    now: Date,
  ): Promise<RoutedTurn | null> {
    const prepared = await this.prepare(workerId, profile, dto, ctx, now);
    if (prepared.kind === "lexicon") return this.routed(workerId, ctx, dto, now, prepared.out);
    if (prepared.kind === "blocked") return null;
    let decided: BrainTurn | null;
    try {
      decided = await this.brain.routeJobsWord(
        brainInputOf(workerId, profile, dto, ctx, now, prepared.promptText, prepared.recent),
      );
    } catch (err) {
      this.logger.error(
        `companion brain failed on a jobs message for worker ${workerId}; v1's jobs answer is served (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
      return null;
    }
    if (decided === null) return null;
    return this.routed(workerId, ctx, dto, now, brainServed(decided, prepared.promptText));
  }

  private async route(
    workerId: string,
    profile: WorkerProfile,
    dto: CompanionMessageDto,
    ctx: RequestContext,
    now: Date,
  ): Promise<RoutedTurn> {
    const prepared = await this.prepare(workerId, profile, dto, ctx, now);
    if (prepared.kind === "lexicon") return this.routed(workerId, ctx, dto, now, prepared.out);
    // The gateway refused or was unreachable: the clarify line, as a fail-closed turn.
    if (prepared.kind === "blocked")
      return this.routed(workerId, ctx, dto, now, this.clarifyFallback());
    const { promptText, recent } = prepared;

    // ADR-0055 — THE FREE-CHAT BRAIN classifies and answers instead of steps 3-4, on the same
    // gateway text and the same memory. The kill switch keeps the v2 steps below, byte for byte.
    if (companionBrainOn(this.config)) {
      return this.routeBrain(workerId, profile, dto, ctx, now, promptText, recent);
    }

    // 3. CLASSIFY the contract's first CLASSIFY_TEXT_MAX chars — the same clipped text is what
    //    memory keeps, because the store drops any turn over that bound on read. Every failure
    //    mode lands on the SAME closed answer: `unclear`.
    const classifyText = clipText(promptText, CLASSIFY_TEXT_MAX);
    const classified = await this.ai.companionClassify(
      { text: classifyText, recent_turns: recent.slice(-2) },
      ctx,
    );
    // THE SPEND IS RECORDED BEFORE ANY BRANCH BELOW CAN RETURN — the `ResumeParseService.parse`
    // rule: a call that happened was billed whatever its content turned out to be. `record`
    // no-ops on a null meta, which is what the blocked path and an unreachable service both
    // send (ADR-0046 O12: cost is watched, never capped).
    await this.cost.record(
      classified?.ai_metadata ?? null,
      "companion_classify",
      null,
      ctx.correlationId,
      ctx.requestId,
      { workerId },
    );
    let intent: CompanionV2Intent;
    let intentSource: CompanionV2IntentSourceV3;
    let v2Intent: CompanionV2Intent | null;
    let confidenceBucket: CompanionV2ConfidenceBucket | null;
    if (classified === null || classified.blocked) {
      intent = "unclear";
      intentSource = "fallback";
      v2Intent = null;
      confidenceBucket = null;
    } else {
      v2Intent = classified.intent;
      confidenceBucket = confidenceBucketOf(classified.confidence);
      intent =
        classified.confidence < this.config.CHAT_COMPANION_V2_ROUTER_MIN_CONFIDENCE
          ? "unclear"
          : classified.intent;
      intentSource = "llm";
    }

    // 4. THE HANDLER.
    const handled = await this.registry.resolve(intent).handle({
      workerId,
      profile,
      text: promptText,
      recentTurns: recent,
      ctx,
      now,
      submissionId: dto.submission_id ?? null,
    });

    // 5 + 6. MEMORY, THEN THE SPINE. A message the CLASSIFIER called faltu — at any confidence,
    //    with the faltu phase on or off — is never model context, exactly like one the lexicon
    //    caught: pseudonymizing masks PII, not abuse, and memory is replayed to later model calls.
    //    It is stored only for the worker's own 7-day history (ADR-0056).
    return this.routed(workerId, ctx, dto, now, {
      turn: handled.turn,
      intentSource,
      v2Intent,
      confidenceBucket,
      outcome: handled.outcome,
      memoryPair:
        v2Intent === "faltu" ? null : { workerText: classifyText, reply: handled.turn.reply },
    });
  }

  /**
   * ADR-0055 — a v1 miss answered by the free-chat brain (`CompanionBrain`), then memory and the
   * spine exactly as a classified v2 turn: the pair is stored unless the classifier called the
   * message trash, and the brain's facts ride the v4 event.
   *
   * FAILS CLOSED: a brain that throws (nothing in it should — every model call already fails soft
   * to a fixed line) serves the clarify line as a fail-closed turn, never kept for a retry, and an
   * error log with the worker id and the error CLASS only. A companion hiccup never costs the worker
   * their chat tab.
   */
  private async routeBrain(
    workerId: string,
    profile: WorkerProfile,
    dto: CompanionMessageDto,
    ctx: RequestContext,
    now: Date,
    promptText: string,
    recent: readonly CompanionRecentTurn[],
  ): Promise<RoutedTurn> {
    let decided: BrainTurn;
    try {
      decided = await this.brain.route(
        brainInputOf(workerId, profile, dto, ctx, now, promptText, recent),
      );
    } catch (err) {
      this.logger.error(
        `companion brain failed for worker ${workerId}; the clarify line is served (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
      return this.routed(workerId, ctx, dto, now, {
        turn: v2CopyTurn(V2_CLARIFY, taskChips(this.config)),
        intentSource: "fallback",
        v2Intent: null,
        confidenceBucket: null,
        outcome: "clarify",
        memoryPair: null,
      });
    }
    return this.routed(workerId, ctx, dto, now, brainServed(decided, promptText));
  }

  /**
   * `finish` for the v1-miss route: the served turn, and whether a retry of the same submission
   * may be answered with it — every turn except a fail-closed one (see `handleMessage`).
   */
  private async routed(
    workerId: string,
    ctx: RequestContext,
    dto: CompanionMessageDto,
    now: Date,
    out: ServedTurn,
  ): Promise<RoutedTurn> {
    return {
      turn: await this.finish(workerId, ctx, dto, now, out),
      replayable: out.intentSource !== "fallback",
    };
  }

  /**
   * The ONE copy of the worker's message that the classifier, the handlers and memory see, or
   * `null` when the gateway is unreachable or refused it.
   *
   * `AI_RAW_PII_ENABLED` (owner decision 2026-09-30, ADR-0047) is the only thing that
   * changes this. Off — the default, and today's behaviour exactly — the gateway pseudonymizes
   * and a blocked or unreachable gateway fails closed. On, the gateway hop is skipped and the
   * worker's own words go onward UNMASKED, so an unreachable AI service can no longer
   * short-circuit to the clarify line here — that is intended: the classify call behind it fails
   * soft to `unclear` on its own. The Redis memory then holds raw text too, bounded by
   * `CHAT_COMPANION_V2_MEMORY_TTL_SECONDS` — and past a revert, until those turns trim out or
   * expire (see `CompanionMemoryStore`). The DTO's own 4,000-character cap still bounds the
   * message, and the event and every log line stay text-free either way.
   */
  private async promptTextOf(text: string, ctx: RequestContext): Promise<string | null> {
    if (this.config.AI_RAW_PII_ENABLED === true) return text;
    const pseudo = await this.ai.pseudonymize(text, ctx);
    return pseudo === null || pseudo.blocked ? null : pseudo.pseudonymized_text;
  }

  /** Memory append + the v2 event, both best-effort; the turn is served either way. */
  private async finish(
    workerId: string,
    ctx: RequestContext,
    dto: CompanionMessageDto,
    now: Date,
    out: ServedTurn,
  ): Promise<CompanionTurn> {
    if (out.memoryPair !== null) {
      await this.memory.append(workerId, { role: "worker", text: out.memoryPair.workerText });
      await this.memory.append(workerId, {
        role: "bada_bhai",
        text: clipText(out.memoryPair.reply, MEMORY_REPLY_MAX),
      });
      this.remembered.add(out.turn);
    }
    await this.record(workerId, ctx, dto, now, out);
    return out.turn;
  }

  /**
   * #2297 (ADR-0056) — may a LATER model call read this turn? True exactly when its pair went into
   * the memory, so the stored conversation feeds a model the same turns the Redis memory did: never
   * a distress turn, a trash verdict, a chip tap or a guard line (ADR-0055 F3/F4). Keyed by the
   * IDENTITY of the turn this class returned; any other object — a v1 turn, a replayed one — is
   * false.
   */
  rememberedForModel(turn: CompanionTurn): boolean {
    return this.remembered.has(turn);
  }

  /**
   * #2297 (ADR-0056) — is this turn an ECHO of a submission another request owns: the in-flight
   * line, or the replay of a turn already served? An echo is never written to the stored
   * conversation — the request that owns the submission stores the real turn, once. (Writing the
   * in-flight line would land FIRST and the real reply would then be skipped as its duplicate.)
   */
  isEcho(turn: CompanionTurn): boolean {
    return this.echoes.has(turn);
  }

  private echo(turn: CompanionTurn): CompanionTurn {
    this.echoes.add(turn);
    return turn;
  }

  /**
   * `chat.companion_turn_served_v4` (ADR-0055) — the v1 counts-and-closed-sets shape plus the
   * router's own facts and the free-chat brain's. Never any worker text. What the fields MEAN on
   * this event (see contracts §4):
   *   - `intent` is ALWAYS v1's `fallback` — "no named v1 intent answered this turn". That holds
   *     for the classifier path and is merely nominal for a chip tap or a guard turn, which run
   *     before v1; the truth of the turn lives in `v2_intent` / `outcome`;
   *   - `intent_source` is `chip` for an exact task-chip tap, `v1_deterministic` for the other
   *     deterministic pre-classifier routes (WP6), `lexicon` for the abuse and distress word lists,
   *     `llm` for a classifier, `guard` for the cool-down and `fallback` for a fail-closed turn;
   *   - `v2_intent` is the intent the turn was routed on — the chip's, a word list's, or the
   *     classifier's (recorded even below the confidence floor) — and null on the guard and
   *     fail-closed paths; `confidence_bucket` is set only when a classifier answered;
   *   - the brain's six fields are null (and the tile count 0) on every turn it did not decide.
   *
   * v2 and v3 stay registered and are no longer emitted: this is the one turn event from ADR-0055.
   */
  private async record(
    workerId: string,
    ctx: RequestContext,
    dto: CompanionMessageDto,
    now: Date,
    out: {
      intentSource: CompanionV2IntentSourceV3;
      v2Intent: CompanionV3Intent | null;
      confidenceBucket: CompanionV2ConfidenceBucket | null;
      outcome: CompanionV3Outcome;
      brain?: BrainFacts;
    },
  ): Promise<void> {
    const brain = out.brain ?? NO_BRAIN_FACTS;
    try {
      await this.events.emit({
        event_name: "chat.companion_turn_served_v4",
        actor: { actor_type: "worker", actor_id: workerId },
        subject: { subject_type: "worker", subject_id: workerId },
        payload: {
          worker_id: workerId,
          trigger: "message",
          intent: "fallback",
          applied_count: null,
          new_jobs_count: null,
          jobs_scope: null,
          job_chips_count: 0,
          resume_source: null,
          nudge: null,
          day: now.toISOString().slice(0, 10),
          intent_source: out.intentSource,
          v2_intent: out.v2Intent,
          confidence_bucket: out.confidenceBucket,
          outcome: out.outcome,
          free_category: brain.freeCategory,
          resume_action: brain.resumeAction,
          refusal_topic: brain.refusalTopic,
          reply_language: brain.replyLanguage,
          news_outcome: brain.newsOutcome,
          news_source_count: brain.newsSourceCount,
        },
        ...(dto.submission_id
          ? { idempotencyKey: `chat.companion_turn_served_v4:message:${workerId}:${dto.submission_id}` }
          : {}),
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    } catch (err) {
      // BEST-EFFORT: the spine never costs the worker their answer.
      this.logger.error(
        `chat.companion_turn_served_v4 not recorded for worker ${workerId} (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
    }
  }
}

/** The brain's input for one message: the gateway's copy, the memory, the turn's ids. */
function brainInputOf(
  workerId: string,
  profile: WorkerProfile,
  dto: CompanionMessageDto,
  ctx: RequestContext,
  now: Date,
  promptText: string,
  recent: readonly CompanionRecentTurn[],
): BrainInput {
  return {
    workerId,
    profile,
    rawText: dto.text,
    promptText,
    recentTurns: recent,
    ctx,
    now,
    submissionId: dto.submission_id ?? null,
  };
}

/**
 * A brain turn as the spine and the memory take it: the pair is stored unless the brain says not to
 * (trash, distress), and the brain's facts ride the v4 event.
 */
function brainServed(decided: BrainTurn, promptText: string): ServedTurn {
  return {
    turn: decided.turn,
    intentSource: decided.intentSource,
    v2Intent: decided.v2Intent,
    confidenceBucket: decided.confidenceBucket,
    outcome: decided.outcome,
    memoryPair: decided.remember
      ? { workerText: clipText(promptText, CLASSIFY_TEXT_MAX), reply: decided.turn.reply }
      : null,
    brain: decided.facts,
  };
}

/** The contracts §4 buckets: lt50 / 50_70 / 70_90 / gte90. */
function confidenceBucketOf(confidence: number): CompanionV2ConfidenceBucket {
  if (confidence < 0.5) return "lt50";
  if (confidence < 0.7) return "50_70";
  if (confidence < 0.9) return "70_90";
  return "gte90";
}
