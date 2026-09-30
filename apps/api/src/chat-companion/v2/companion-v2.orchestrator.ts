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
import { CompanionTurnReplayStore } from "./turn-replay.store";

/** The reply stored as the companion's side of a memory turn — a context line, not a record. */
const MEMORY_REPLY_MAX = 1_000;

/**
 * The classify contract's text bound (contracts §2.1, `CompanionClassifyInputSchema.text`) — and
 * the memory store's per-turn bound, which is the same number. The API accepts a 4000-char
 * message, so the classifier sees its first 1000: a longer text would be a 422, i.e. `unclear`
 * for a message that was perfectly clear. The HANDLER still gets the whole masked text (the
 * edit-parse and career contracts take 4000). Pinned against the schema in the orchestrator test.
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
 * from three places in `ChatCompanionService.message`: an OPEN task-chip tap (`handleTaskChip`,
 * before v1), a free-text message during a faltu cool-down (`handleCooldown`, before v1), and a
 * v1 MISS (`handleMessage`). A v1 resolver hit never arrives here: it is served by v1 with zero
 * model calls and records v1's own `chat.companion_turn_served`, not the v2 event.
 *
 * THE ORDER IS THE PRIVACY ORDER, and it fails closed at every step:
 *   0. a RETRIED submission (same `submission_id`) is answered with the turn already served —
 *      nothing below runs again (no model call, no strike, no memory append, no second event);
 *   1. the ABUSE LEXICON (P2, only while the faltu flag is on) — deterministic, local, and
 *      BEFORE the gateway: a message it flags reaches no provider, no model, no memory;
 *   2. pseudonymize the message through the gateway — a blocked or unreachable gateway serves the
 *      clarify line WITHOUT a classifier call and stores nothing;
 *   3. read the (already pseudonymized) memory, last two turns;
 *   4. classify the first `CLASSIFY_TEXT_MAX` chars — null, blocked or a schema miss is
 *      `unclear`; a confidence below the configured floor is `unclear` too;
 *   5. the registry picks the handler from the closed intent set;
 *   6. append the pseudonymized pair to memory — never for a message the classifier called
 *      `faltu` (abuse the lexicon missed is still never stored);
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
    return this.finish(workerId, ctx, dto, now, {
      turn: handled.turn,
      intentSource: "v1_deterministic",
      v2Intent: intent,
      confidenceBucket: null,
      outcome: handled.outcome,
      memoryPair: null,
    });
  }

  /**
   * A v1 MISS. A retried submission is answered from the replay cache FIRST — before the lexicon,
   * so a retried abusive message is not a second strike — and every freshly served turn is kept
   * there for its own retry. Without a `submission_id` (an older client) there is nothing to key
   * on and the message is simply processed.
   */
  async handleMessage(
    workerId: string,
    profile: WorkerProfile,
    dto: CompanionMessageDto,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<CompanionTurn> {
    const submissionId = dto.submission_id;
    if (submissionId === undefined) return this.route(workerId, profile, dto, ctx, now);

    const replayed = await this.replays.read(workerId, submissionId);
    if (replayed !== null) return replayed;
    const turn = await this.route(workerId, profile, dto, ctx, now);
    await this.replays.remember(workerId, submissionId, turn);
    return turn;
  }

  private async route(
    workerId: string,
    profile: WorkerProfile,
    dto: CompanionMessageDto,
    ctx: RequestContext,
    now: Date,
  ): Promise<CompanionTurn> {
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
      return this.finish(workerId, ctx, dto, now, {
        turn: handled.turn,
        intentSource: "lexicon",
        v2Intent: "faltu",
        confidenceBucket: null,
        outcome: handled.outcome,
        memoryPair: null,
      });
    }

    // 1. THE GATEWAY FIRST. `null` is the AI service being unreachable; `blocked` is the gateway
    //    refusing. Both serve the clarify line and neither reaches a model or Redis.
    const pseudo = await this.ai.pseudonymize(dto.text, ctx);
    if (pseudo === null || pseudo.blocked) {
      return this.finish(workerId, ctx, dto, now, {
        turn: v2CopyTurn(V2_CLARIFY, taskChips(this.config)),
        intentSource: "fallback",
        v2Intent: null,
        confidenceBucket: null,
        outcome: "clarify",
        memoryPair: null,
      });
    }

    // 2. MEMORY — already pseudonymized at rest. The classifier sees at most the last two
    //    turns; the FULL read (up to MEMORY_TURNS) rides the handler input, because the Phase 3
    //    career answer reads up to six and a second Redis hop would buy nothing.
    const recent = await this.memory.read(workerId);

    // 3. CLASSIFY the contract's first CLASSIFY_TEXT_MAX chars — the same clipped text is what
    //    memory keeps, because the store drops any turn over that bound on read. Every failure
    //    mode lands on the SAME closed answer: `unclear`.
    const classifyText = clipText(pseudo.pseudonymized_text, CLASSIFY_TEXT_MAX);
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
      text: pseudo.pseudonymized_text,
      recentTurns: recent,
      ctx,
      now,
    });

    // 5 + 6. MEMORY, THEN THE SPINE. A message the CLASSIFIER called faltu — at any confidence,
    //    with the faltu phase on or off — is never stored, exactly like one the lexicon caught:
    //    pseudonymizing masks PII, not abuse, and memory is replayed to later model calls.
    return this.finish(workerId, ctx, dto, now, {
      turn: handled.turn,
      intentSource,
      v2Intent,
      confidenceBucket,
      outcome: handled.outcome,
      memoryPair:
        v2Intent === "faltu" ? null : { workerText: classifyText, reply: handled.turn.reply },
    });
  }

  /** Memory append + the v2 event, both best-effort; the turn is served either way. */
  private async finish(
    workerId: string,
    ctx: RequestContext,
    dto: CompanionMessageDto,
    now: Date,
    out: {
      turn: CompanionTurn;
      intentSource: CompanionV2IntentSource;
      v2Intent: CompanionV2Intent | null;
      confidenceBucket: CompanionV2ConfidenceBucket | null;
      outcome: CompanionV2Outcome;
      memoryPair: { workerText: string; reply: string } | null;
    },
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
