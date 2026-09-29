import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { WorkerProfile } from "@badabhai/db";
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
import { V2_CLARIFY } from "../companion-replies";
import { CompanionMemoryStore } from "./companion-memory.store";
import { taskChips, v2CopyTurn } from "./companion-v2-compose";
import { CompanionHandlerRegistry } from "./handlers/registry";

/** The reply stored as the companion's side of a memory turn — a context line, not a record. */
const MEMORY_REPLY_MAX = 1_000;

/**
 * THE V2 TURN PIPELINE (ADR-0046 §2.1) — reached ONLY when `CHAT_COMPANION_V2_ENABLED` is on AND
 * the v1 deterministic resolver missed. v1 hits never arrive here and still cost zero model calls.
 *
 * THE ORDER IS THE PRIVACY ORDER, and it fails closed at every step:
 *   1. pseudonymize the message through the gateway — a blocked or unreachable gateway serves the
 *      clarify line WITHOUT a classifier call and stores nothing;
 *   2. read the (already pseudonymized) memory, last two turns;
 *   3. classify — null, blocked or a schema miss is `unclear`; a confidence below the configured
 *      floor is `unclear` too;
 *   4. the registry picks the handler from the closed intent set;
 *   5. append the pseudonymized pair to memory;
 *   6. emit `chat.companion_turn_served_v2` — ids, counts and closed enums only.
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
  ) {}

  async handleMessage(
    workerId: string,
    profile: WorkerProfile,
    dto: CompanionMessageDto,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<CompanionTurn> {
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

    // 2. MEMORY — already pseudonymized at rest; the classifier sees at most the last two turns.
    const recent = (await this.memory.read(workerId)).slice(-2);

    // 3. CLASSIFY. Every failure mode lands on the SAME closed answer: `unclear`.
    const classified = await this.ai.companionClassify(
      { text: pseudo.pseudonymized_text, recent_turns: recent },
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
      ctx,
      now,
    });

    // 5 + 6. MEMORY, THEN THE SPINE.
    return this.finish(workerId, ctx, dto, now, {
      turn: handled.turn,
      intentSource,
      v2Intent,
      confidenceBucket,
      outcome: handled.outcome,
      memoryPair: { workerText: pseudo.pseudonymized_text, reply: handled.turn.reply },
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
        text: out.memoryPair.reply.slice(0, MEMORY_REPLY_MAX),
      });
    }
    await this.record(workerId, ctx, dto, now, out);
    return out.turn;
  }

  /**
   * `chat.companion_turn_served_v2` — the v1 counts-and-closed-sets shape plus the router's own
   * facts. `intent` stays the V1 vocabulary (`fallback`: the resolver had no answer), and the
   * truth of the turn lives in `v2_intent` / `outcome`. Never any worker text.
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
