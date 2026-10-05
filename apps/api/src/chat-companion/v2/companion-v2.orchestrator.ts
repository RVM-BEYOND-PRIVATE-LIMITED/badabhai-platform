import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { WorkerProfile } from "@badabhai/db";
import { isAbusive } from "@badabhai/profiling-lexicon";
import type {
  CompanionV2ConfidenceBucket,
  CompanionV2Intent,
  CompanionV2IntentSource,
  CompanionV2Outcome,
} from "@badabhai/types";
import { SERVER_CONFIG } from "../../config/config.module";
import { AiCostRecorder } from "../../ai/ai-cost-recorder.service";
import { AiService } from "../../ai/ai.service";
import type { RequestContext } from "../../common/request-context";
import { EventsService } from "../../events/events.service";
import type { CompanionMessageDto, CompanionTurn } from "../chat-companion.dto";
import { V2_CAREER_ASK, V2_CLARIFY, V2_EDIT_ASK, type CopyPair } from "../companion-replies";
import { CompanionMemoryStore } from "./companion-memory.store";
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

/** A turn about to be served, with the facts its memory append and its v2 event need. */
interface ServedTurn {
  turn: CompanionTurn;
  intentSource: CompanionV2IntentSource;
  v2Intent: CompanionV2Intent | null;
  confidenceBucket: CompanionV2ConfidenceBucket | null;
  outcome: CompanionV2Outcome;
  memoryPair: { workerText: string; reply: string } | null;
}

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
 *      message the classifier called `faltu` (abuse the lexicon missed is still never stored);
 *   7. emit `chat.companion_turn_served_v2` — ids, counts and closed enums only.
 *
 * The model NEVER decides anything but the intent: handlers are deterministic, and the only
 * handler that can cause a write is the edit one, which still requires the worker's Haan.
 */
@Injectable()
export class CompanionV2Orchestrator {
  private readonly logger = new Logger(CompanionV2Orchestrator.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly ai: AiService,
    private readonly memory: CompanionMemoryStore,
    private readonly registry: CompanionHandlerRegistry,
    private readonly events: EventsService,
    private readonly cost: AiCostRecorder,
    private readonly faltu: FaltuStore,
    private readonly replays: CompanionTurnReplayStore,
    private readonly pending: PendingIntentStore,
  ) {}

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
          });
    // WP6: the tap remembers the task for the NEXT message (edit/career), or clears a stale one
    // (any other task chip). Best-effort — the tap's own answer is already in hand either way.
    if (this.routePrecedenceOn()) {
      if (intent === "edit_resume" || intent === "career_talk") {
        await this.pending.set(workerId, intent);
      } else {
        await this.pending.clear(workerId);
      }
    }
    return this.finish(workerId, ctx, dto, now, {
      turn: handled.turn,
      intentSource: "v1_deterministic",
      v2Intent: intent,
      confidenceBucket: null,
      outcome: handled.outcome,
      memoryPair: null,
    });
  }

  /** `CHAT_COMPANION_V2_ROUTE_PRECEDENCE_ENABLED` (TD146, WP6) — default off. */
  private routePrecedenceOn(): boolean {
    return (
      this.config.CHAT_COMPANION_V2_ENABLED &&
      this.config.CHAT_COMPANION_V2_ROUTE_PRECEDENCE_ENABLED === true
    );
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
   */
  async handleDirectIntent(
    workerId: string,
    profile: WorkerProfile,
    dto: CompanionMessageDto,
    intent: PendingIntent,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<CompanionTurn> {
    if (this.config.CHAT_COMPANION_V2_FALTU_ENABLED && isAbusive(dto.text)) {
      const handled = await this.registry.resolve("faltu").handle({
        workerId,
        profile,
        text: "",
        recentTurns: [],
        ctx,
        now,
      });
      return this.finish(workerId, ctx, dto, now, {
        turn: handled.turn,
        intentSource: "lexicon",
        v2Intent: "faltu",
        confidenceBucket: null,
        outcome: handled.outcome,
        memoryPair: null,
      });
    }
    const promptText = await this.promptTextOf(dto.text, ctx);
    if (promptText === null) {
      return this.finish(workerId, ctx, dto, now, {
        turn: v2CopyTurn(V2_CLARIFY, taskChips(this.config)),
        intentSource: "fallback",
        v2Intent: null,
        confidenceBucket: null,
        outcome: "clarify",
        memoryPair: null,
      });
    }
    const recent = await this.memory.read(workerId);
    const handled = await this.registry.resolve(intent).handle({
      workerId,
      profile,
      text: promptText,
      recentTurns: recent,
      ctx,
      now,
    });
    return this.finish(workerId, ctx, dto, now, {
      turn: handled.turn,
      intentSource: "v1_deterministic",
      v2Intent: intent,
      confidenceBucket: null,
      outcome: handled.outcome,
      memoryPair: {
        workerText: clipText(promptText, CLASSIFY_TEXT_MAX),
        reply: handled.turn.reply,
      },
    });
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
    const submissionId = dto.submission_id;
    if (submissionId === undefined) return (await this.route(workerId, profile, dto, ctx, now)).turn;

    const replayed = await this.replays.read(workerId, submissionId);
    if (replayed !== null) return replayed;
    const routed = await this.route(workerId, profile, dto, ctx, now);
    if (routed.replayable) await this.replays.remember(workerId, submissionId, routed.turn);
    return routed.turn;
  }

  private async route(
    workerId: string,
    profile: WorkerProfile,
    dto: CompanionMessageDto,
    ctx: RequestContext,
    now: Date,
  ): Promise<RoutedTurn> {
    // 0. THE ABUSE LEXICON (P2, O11), only while the faltu phase is on. It runs BEFORE the
    //    gateway because nothing crosses a boundary on this path: the answer is fixed copy and
    //    a strike count. A flagged message therefore costs no gateway hop and no model call,
    //    and — because the finish below passes no memory pair — it is never stored anywhere.
    if (this.config.CHAT_COMPANION_V2_FALTU_ENABLED && isAbusive(dto.text)) {
      const handled = await this.registry.resolve("faltu").handle({
        workerId,
        profile,
        text: "",
        recentTurns: [],
        ctx,
        now,
      });
      return this.routed(workerId, ctx, dto, now, {
        turn: handled.turn,
        intentSource: "lexicon",
        v2Intent: "faltu",
        confidenceBucket: null,
        outcome: handled.outcome,
        memoryPair: null,
      });
    }

    // 1. THE GATEWAY FIRST (see `promptTextOf`). `null` is the AI service being unreachable or
    //    the gateway refusing. Both serve the clarify line and neither reaches a model or Redis.
    const promptText = await this.promptTextOf(dto.text, ctx);
    if (promptText === null) {
      return this.routed(workerId, ctx, dto, now, {
        turn: v2CopyTurn(V2_CLARIFY, taskChips(this.config)),
        intentSource: "fallback",
        v2Intent: null,
        confidenceBucket: null,
        outcome: "clarify",
        memoryPair: null,
      });
    }

    // 2. MEMORY — pseudonymized at rest, raw while `AI_RAW_PII_ENABLED` is on. The classifier sees
    //    at most the last two turns; the FULL read (up to MEMORY_TURNS) rides the handler input,
    //    because the Phase 3 career answer reads up to six and a second Redis hop would buy nothing.
    const recent = await this.memory.read(workerId);

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
    let intentSource: CompanionV2IntentSource;
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
    });

    // 5 + 6. MEMORY, THEN THE SPINE. A message the CLASSIFIER called faltu — at any confidence,
    //    with the faltu phase on or off — is never stored, exactly like one the lexicon caught:
    //    pseudonymizing masks PII, not abuse, and memory is replayed to later model calls.
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
    }
    await this.record(workerId, ctx, dto, now, out);
    return out.turn;
  }

  /**
   * `chat.companion_turn_served_v2` — the v1 counts-and-closed-sets shape plus the router's own
   * facts. Never any worker text. What the fields MEAN on this event (the schema's closed sets
   * are unchanged; see contracts §4):
   *   - `intent` is ALWAYS v1's `fallback` — "no named v1 intent answered this turn". That holds
   *     for the classifier path and is merely nominal for a chip tap or a guard turn, which run
   *     before v1; the truth of the turn lives in `v2_intent` / `outcome`;
   *   - `intent_source` is `v1_deterministic` ONLY for a task-chip tap (exact label/key match, no
   *     model) — a v1 resolver hit never reaches this event; `lexicon`, `llm`, `guard` (the
   *     cool-down) and `fallback` (gateway blocked/unreachable, classifier failed) as named;
   *   - `v2_intent` is the intent the turn was routed on — the chip's, the lexicon's `faltu`, or
   *     the classifier's (recorded even below the confidence floor) — and null on the guard and
   *     fail-closed paths; `confidence_bucket` is set only when the classifier answered.
   */
  private async record(
    workerId: string,
    ctx: RequestContext,
    dto: CompanionMessageDto,
    now: Date,
    out: {
      intentSource: CompanionV2IntentSource;
      v2Intent: CompanionV2Intent | null;
      confidenceBucket: CompanionV2ConfidenceBucket | null;
      outcome: CompanionV2Outcome;
    },
  ): Promise<void> {
    try {
      await this.events.emit({
        event_name: "chat.companion_turn_served_v2",
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
        },
        ...(dto.submission_id
          ? { idempotencyKey: `chat.companion_turn_served_v2:message:${workerId}:${dto.submission_id}` }
          : {}),
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    } catch (err) {
      // BEST-EFFORT: the spine never costs the worker their answer.
      this.logger.error(
        `chat.companion_turn_served_v2 not recorded for worker ${workerId} (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
    }
  }
}

/** The contracts §4 buckets: lt50 / 50_70 / 70_90 / gte90. */
function confidenceBucketOf(confidence: number): CompanionV2ConfidenceBucket {
  if (confidence < 0.5) return "lt50";
  if (confidence < 0.7) return "50_70";
  if (confidence < 0.9) return "70_90";
  return "gte90";
}
