import { Injectable, Logger } from "@nestjs/common";
import {
  LlmTurnInputSchema,
  ProfilingTurnUnderstandInputSchema,
  type LlmBridgeReason,
  type LlmInterviewStage,
  type ProfilingProgress,
  type ProfilingSchemaRow,
  type ProfilingTurnUnderstandOutput,
} from "@badabhai/ai-contracts";
import { checkPersonaTokens } from "@badabhai/profiling-lexicon";

import { AiService } from "../../ai/ai.service";
import { AiCostRecorder } from "../../ai/ai-cost-recorder.service";
import { AiTraceRecorder } from "../../ai/ai-trace-recorder.service";
import { redactKnownName, type KnownNameSource } from "../../common/redact-known-name";
import { PAGE_OWNED_FACTS } from "./profiling-schema";

/**
 * THE PROFILING TURN'S TWO MODEL CALLS (ADR-0057, #2311) — and nothing else: no state, no write.
 *
 *   `understand` — `profiling_turn_understand`: one typed message, read against the session's
 *       whole schema. Null unless the answer is a REAL verdict (a real call, not blocked, not a
 *       mock, on-contract): every other outcome is "run the turn exactly as today" (§3.6).
 *   `bridge` — `profiling_chat_turn` in `bridge` mode: one short line before a pack question the
 *       engine chose. Null unless the line is real, non-empty and on-persona
 *       (`checkPersonaTokens`, the API's own persona check): the worker then reads the bare
 *       question, as today.
 *
 * THE WORKER'S OWN NAME NEVER REACHES EITHER MODEL (ADR-0047 G2), and here THAT FAILS CLOSED: a
 * name that cannot be read means no call at all, because neither call is needed for the interview
 * to work. Every string the model reads — the message, the turns, the question, every schema value
 * and every noted line — is redacted with it first.
 *
 * SPEND IS RECORDED BEFORE ANY BRANCH, like every call site: a reply that fails a check still cost
 * what it cost. The caller memoises both calls per turn, so a lost CAS never pays twice.
 */

/** One prior chat line, as the transcript buffer holds it. */
export interface UnderstandingTurnLine {
  readonly role: "worker" | "assistant";
  readonly text: string;
}

export interface UnderstandingCallContext {
  readonly workerId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly requestId: string;
  readonly knownName: KnownNameSource;
}

export interface UnderstandRequest {
  readonly text: string;
  /** The chat so far, oldest first, WITHOUT this message. The last few are sent. */
  readonly history: readonly UnderstandingTurnLine[];
  /** The question on screen: its schema key (null for a model-written one), words and chips. */
  readonly onScreen: {
    readonly key: string | null;
    readonly text: string;
    readonly options: readonly string[];
  } | null;
  readonly schema: readonly ProfilingSchemaRow[];
  readonly progress: ProfilingProgress | null;
}

export interface BridgeRequest {
  readonly reason: LlmBridgeReason;
  /** "Label: value" lines — what was just noted. */
  readonly noted: readonly string[];
  /** The pack question the engine appends after the line, verbatim. */
  readonly nextQuestion: string;
  readonly remaining: number | null;
  readonly text: string;
  readonly stage: LlmInterviewStage;
}

/** The contract's bounds, applied before the parse so a long turn is clipped, not refused. */
const TEXT_MAX = 4000;
const TURN_TEXT_MAX = 1000;
const TURNS_SENT = 6;
const SCREEN_MAX = 500;
const OPTION_MAX = 80;
const OPTIONS_SENT = 20;
const NOTED_MAX = 200;

@Injectable()
export class TurnUnderstandingService {
  private readonly logger = new Logger(TurnUnderstandingService.name);

  constructor(
    private readonly ai: AiService,
    private readonly aiCost: AiCostRecorder,
    private readonly aiTraces: AiTraceRecorder,
  ) {}

  /** The message's real verdict, or null — and null always means "run today's turn". */
  async understand(
    req: UnderstandRequest,
    ctx: UnderstandingCallContext,
  ): Promise<ProfilingTurnUnderstandOutput | null> {
    const name = await this.ownName(ctx);
    if (name === undefined) return null;
    const redact = (text: string): string => redactKnownName(text, name);

    const input = ProfilingTurnUnderstandInputSchema.safeParse({
      text: clip(redact(req.text), TEXT_MAX),
      recent_turns: req.history
        .slice(-TURNS_SENT)
        .map((line) => ({
          role: line.role === "worker" ? "worker" : "bada_bhai",
          text: clip(redact(line.text), TURN_TEXT_MAX),
        }))
        .filter((turn) => turn.text.length > 0),
      on_screen:
        req.onScreen === null || clip(req.onScreen.text, SCREEN_MAX).length === 0
          ? null
          : {
              key: req.onScreen.key,
              text: clip(redact(req.onScreen.text), SCREEN_MAX),
              options: req.onScreen.options
                .slice(0, OPTIONS_SENT)
                .map((option) => clip(option, OPTION_MAX))
                .filter((option) => option.length > 0),
            },
      schema_rows: req.schema.map((row) => ({
        ...row,
        // L1 — options ride only on the on-screen row. Every other row keeps its
        // key, label, kind, value, status and entries; the model reads canonical
        // labels for the asked question from on_screen itself. A null on-screen
        // key (a model-written question) matches no row, so nothing carries options.
        options: req.onScreen !== null && row.key === req.onScreen.key ? row.options : [],
        value: row.value === null ? null : clip(redact(row.value), 500) || null,
        entries: row.entries
          .map((entry) => ({ ...entry, value: clip(redact(entry.value), 500) }))
          .filter((entry) => entry.value.length > 0),
      })),
      page_owned: [...PAGE_OWNED_FACTS],
      progress: req.progress,
    });
    if (!input.success) {
      this.logger.warn(
        `turn understanding input off-contract session=${ctx.sessionId} ` +
          `paths=[${input.error.issues.map((i) => i.path.join(".")).join(",")}]; turn runs as today`,
      );
      return null;
    }

    const out = await this.ai.understandTurn(input.data, {
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
    const meta = out?.ai_metadata ?? null;
    const attribution = { workerId: ctx.workerId, sessionId: ctx.sessionId };
    await this.aiCost.record(
      meta,
      "profiling_turn_understand",
      null,
      ctx.correlationId,
      ctx.requestId,
      attribution,
    );
    await this.aiTraces.capture(meta, "profiling_turn_understand", null, ctx.correlationId, attribution);
    if (out === null || out.blocked || meta === null || !meta.real_call || meta.success === false) {
      return null;
    }
    return out;
  }

  /** One on-persona lead-in line before the next pack question, or null (the bare question). */
  async bridge(req: BridgeRequest, ctx: UnderstandingCallContext): Promise<string | null> {
    const name = await this.ownName(ctx);
    if (name === undefined) return null;
    const redact = (text: string): string => redactKnownName(text, name);

    const input = LlmTurnInputSchema.safeParse({
      schema_version: "oie.v1",
      worker_ref: ctx.workerId,
      stage: req.stage,
      message_text: clip(redact(req.text), TEXT_MAX),
      interview_mode: "bridge",
      ...(req.remaining === null ? {} : { remaining_questions: req.remaining }),
      bridge: {
        reason: req.reason,
        filled: req.noted
          .map((line) => clip(redact(line), NOTED_MAX))
          .filter((line) => line.length > 0)
          .slice(0, 20),
        next_question: clip(req.nextQuestion, SCREEN_MAX) || null,
      },
    });
    if (!input.success) {
      this.logger.warn(`bridge input off-contract session=${ctx.sessionId}; bare question served`);
      return null;
    }

    const out = await this.ai.llmTurn(input.data, {
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
    const meta = out?.ai_metadata ?? null;
    const attribution = { workerId: ctx.workerId, sessionId: ctx.sessionId };
    await this.aiCost.record(
      meta,
      "profiling_chat_turn",
      null,
      ctx.correlationId,
      ctx.requestId,
      attribution,
    );
    await this.aiTraces.capture(meta, "profiling_chat_turn", null, ctx.correlationId, attribution);
    if (out === null || out.is_mock || out.blocked) return null;
    const line = out.reply_text.trim();
    if (line.length === 0 || line.includes("?")) return null;
    if (checkPersonaTokens(line).length > 0) {
      // COUNTS ONLY: what was withheld is what must not be logged.
      this.logger.warn(`bridge line broke the persona session=${ctx.sessionId}; bare question`);
      return null;
    }
    return line;
  }

  /** The worker's own name for the G2 redaction; `undefined` = unreadable, so no call is made. */
  private async ownName(ctx: UnderstandingCallContext): Promise<string | null | undefined> {
    try {
      return await ctx.knownName();
    } catch {
      this.logger.warn(
        `known name unavailable worker=${ctx.workerId} session=${ctx.sessionId}; ` +
          `no understanding call is made (it could not be name-redacted)`,
      );
      return undefined;
    }
  }

}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max).trimEnd();
}
