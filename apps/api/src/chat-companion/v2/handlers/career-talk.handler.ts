import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { WorkerProfile } from "@badabhai/db";
import type { CompanionCareerWorkerContext } from "@badabhai/ai-contracts";
import { labelForTaxonomyId } from "@badabhai/taxonomy";
import { AiCostRecorder } from "../../../ai/ai-cost-recorder.service";
import { AiService } from "../../../ai/ai.service";
import { SERVER_CONFIG } from "../../../config/config.module";
import { EventsService } from "../../../events/events.service";
import { FALLBACK, V2_CAREER_REFUSE } from "../../companion-replies";
import { taskChips, v2CareerAnswerTurn, v2CopyTurn } from "../companion-v2-compose";
import { CHIP_DROP_REASON, screenCareerAnswer } from "../career-output.validator";
import type { CompanionV2Handler, HandlerInput, HandlerResult } from "./handler";

/** The contract's own cap; a longer label is truncated rather than rejecting the request. */
const TRADE_LABEL_MAX = 64;

/**
 * The career contract's memory bound (contracts §2.3, `CompanionCareerInputSchema.recent_turns`,
 * and `turns_in_memory` on the career event). `CHAT_COMPANION_V2_MEMORY_TURNS` is a knob with no
 * ceiling, and above six every career call would be a 422 (the fallback line) and every career
 * event a validation failure — so the handler sends the NEWEST six, whatever the knob says.
 * Pinned against the schema in the handler test.
 */
export const CAREER_TURNS_MAX = 6;

/**
 * CAREER TALK (ADR-0046 P3, O7/O9/O10) — the one handler whose answer a model writes.
 *
 * THE PIPELINE, and where every safety property lives:
 *   1. the closed worker context is built from the CONFIRMED PROFILE (canonical trade label,
 *      coarse experience bucket) — no name, no phone, no employer, no city (O13);
 *   2. `AiService.companionCareer` sends the question, the recent turns and that context; the
 *      far side pseudonymizes fail-closed (unless `AI_RAW_PII_ENABLED` is on, when question and
 *      turns reach the model raw) and answers in Hinglish or refuses;
 *   3. the spend is recorded against `companion_career_answer` (O12) — before any branch, the
 *      `ResumeParseService.parse` rule;
 *   4. a NULL (unreachable, timeout, schema miss) serves the fallback line;
 *   5. a REFUSAL serves the topic's REVIEWED copy (O9) — the model chooses a topic, never words;
 *   6. an ANSWER runs the deterministic validator (`screenCareerAnswer`); ANY failure serves the
 *      fallback line. The prompt asks for all of it, and the validator is what enforces it. The one
 *      exception (owner, 2026-10-03): a follow-up chip whose only failure is its length is dropped
 *      and the rest is served — logged as a count, never the chip.
 *
 * THE EVENT IS THE ONLY TRACE OF THE MODEL'S TEXT and it carries none: outcome, refusal topic
 * and the memory depth, nothing else.
 */
@Injectable()
export class CareerTalkHandler implements CompanionV2Handler {
  private readonly logger = new Logger(CareerTalkHandler.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly ai: AiService,
    private readonly cost: AiCostRecorder,
    private readonly events: EventsService,
  ) {}

  async handle(input: HandlerInput): Promise<HandlerResult> {
    const recentTurns = input.recentTurns.slice(-CAREER_TURNS_MAX);
    const out = await this.ai.companionCareer(
      {
        text: input.text,
        recent_turns: recentTurns,
        worker_context: workerContextOf(input.profile),
      },
      input.ctx,
    );
    // The spend is recorded before any branch below can return; `record` no-ops on null meta.
    await this.cost.record(
      out?.ai_metadata ?? null,
      "companion_career_answer",
      null,
      input.ctx.correlationId,
      input.ctx.requestId,
      { workerId: input.workerId },
    );

    if (out === null) {
      await this.emit(input, "fallback", null);
      return this.fallback();
    }
    if (out.status === "refuse") {
      await this.emit(input, "refused", out.topic);
      return {
        turn: v2CopyTurn(V2_CAREER_REFUSE[out.topic], taskChips(this.config)),
        outcome: "refused",
      };
    }

    const screened = screenCareerAnswer(out);
    if (screened.kind === "reject") {
      // The REASON only — never a line of the answer, which is exactly what must not be logged.
      this.logger.warn(`career answer rejected for worker ${input.workerId} (${screened.failure})`);
      await this.emit(input, "fallback", null);
      return this.fallback();
    }
    if (screened.droppedChips > 0) {
      // The COUNT and the closed reason only — never the chip, which is model text.
      this.logger.log(
        `career answer served for worker ${input.workerId} with ${screened.droppedChips} follow-up chip(s) dropped (reason=${CHIP_DROP_REASON})`,
      );
    }

    await this.emit(input, "answered", null);
    const { lines, followup_chips } = screened.answer;
    return { turn: v2CareerAnswerTurn(lines, followup_chips), outcome: "served" };
  }

  private fallback(): HandlerResult {
    return { turn: v2CopyTurn(FALLBACK, taskChips(this.config)), outcome: "fallback" };
  }

  private async emit(
    input: HandlerInput,
    outcome: "answered" | "refused" | "fallback",
    refusalTopic: string | null,
  ): Promise<void> {
    try {
      await this.events.emit({
        event_name: "chat.companion_career_answered",
        actor: { actor_type: "worker", actor_id: input.workerId },
        subject: { subject_type: "worker", subject_id: input.workerId },
        payload: {
          outcome,
          refusal_topic: refusalTopic,
          // The turns the model was actually SENT — the same cap `handle` applied.
          turns_in_memory: Math.min(input.recentTurns.length, CAREER_TURNS_MAX),
        } as never,
        correlationId: input.ctx.correlationId,
        requestId: input.ctx.requestId,
      });
    } catch (err) {
      // Best-effort, like every companion event: ids and the error CLASS only, never the text.
      this.logger.error(
        `chat.companion_career_answered not recorded for worker ${input.workerId} (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
    }
  }
}

/**
 * The closed worker context the model may see: the canonical trade LABEL (never the id, never
 * raw text) and a coarse experience bucket. Every field is optional and absent-safe — a profile
 * without a resolvable trade or years sends nulls, which the prompt treats as unknown.
 *
 * `experience` is an untyped jsonb column, so the years are read defensively — the same
 * finite-number check `WorkerSkillsRepository` applies to the same field.
 */
export function workerContextOf(profile: WorkerProfile): CompanionCareerWorkerContext {
  const tradeId = profile.canonicalTradeId;
  const tradeLabel = tradeId ? labelForTaxonomyId(tradeId).slice(0, TRADE_LABEL_MAX) : null;
  const experience = profile.experience as Record<string, unknown> | null | undefined;
  const years = experience?.["total_years"];
  return {
    trade_label: tradeLabel,
    experience_bucket: typeof years === "number" && Number.isFinite(years) ? bucketOf(years) : null,
  };
}

/** 0–1 / 1–3 / 3–7 / 7+ — the contract's closed buckets, boundary-inclusive on the lower end. */
function bucketOf(years: number): CompanionCareerWorkerContext["experience_bucket"] {
  if (years < 1) return "0-1";
  if (years < 3) return "1-3";
  if (years < 7) return "3-7";
  return "7+";
}
