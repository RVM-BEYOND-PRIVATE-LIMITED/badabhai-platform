import { Injectable, Logger } from "@nestjs/common";

import {
  FreeChatClassifyInputSchema,
  FreeChatReplyInputSchema,
  type CompanionCareerWorkerContext,
  type CompanionRecentTurn,
  type FreeChatClassifyMode,
  type FreeChatClassifyOutput,
  type FreeChatReplyOutput,
} from "@badabhai/ai-contracts";
import type {
  CompanionV2ConfidenceBucket,
  FreeChatCategory,
  FreeChatDecidedBy,
  FreeChatMode,
  FreeChatModeTrigger,
  FreeChatOutcome,
  FreeChatRefusalTopic,
  FreeChatReplyCategory,
} from "@badabhai/types";

// VALUE imports, not `import type`: each is a constructor parameter, and Nest resolves them from
// the emitted `design:paramtypes` — a type-only import would leave this service unwired at boot.
import { AiCostRecorder } from "../../ai/ai-cost-recorder.service";
import { AiService } from "../../ai/ai.service";
import { ChatRepository } from "../../chat/chat.repository";
import type { BufferedMessage } from "../../chat/chat-transcript.buffer";
import { logSafeReason } from "../../common/db-error";
import { redactKnownName, type KnownNameSource } from "../../common/redact-known-name";
import type { RequestContext } from "../../common/request-context";
import { EventsService } from "../../events/events.service";
import { isUniversalPlaceholderLabel } from "../../occupation/family-chip-labels";
import { UNAVAILABLE_VERDICT, type FreeChatVerdict } from "./free-chat.router";

/** The classify contract's text bound (`FreeChatClassifyInputSchema.text`). */
export const CLASSIFY_TEXT_MAX = 1_000;
/** The reply contract's text bound (`FreeChatReplyInputSchema.text`) — the chat DTO's own cap. */
export const REPLY_TEXT_MAX = 4_000;
/** One recent turn's bound (`CompanionRecentTurnSchema.text`). */
const RECENT_TURN_MAX = 1_000;
/** The pending question's bound (`FreeChatClassifyInputSchema.pending_question`). */
const PENDING_QUESTION_MAX = 500;
/** Recent turns each call may carry (the contract's caps). */
export const CLASSIFY_TURNS = 2;
export const REPLY_TURNS = 6;
/** The worker context's trade-label bound (`CompanionCareerWorkerContextSchema.trade_label`). */
const TRADE_LABEL_MAX = 64;

/** Who one model call or one event belongs to — ids and the request's correlation only. */
export interface FreeChatCallContext {
  readonly workerId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly requestId: string;
  /** The worker's own name, for the G2 redaction — a thunk, read only by a call that is made. */
  readonly knownName: KnownNameSource;
}

/** One classifier call's inputs, before redaction. */
export interface FreeChatClassifyRequest {
  readonly text: string;
  readonly mode: FreeChatClassifyMode;
  /** The interview question on screen (résumé mode); null in free mode. */
  readonly pendingQuestion: string | null;
  readonly messages: readonly BufferedMessage[];
}

/** One reply call's inputs, before redaction. */
export interface FreeChatReplyRequest {
  readonly category: FreeChatReplyCategory;
  readonly text: string;
  readonly messages: readonly BufferedMessage[];
  readonly workerContext: CompanionCareerWorkerContext;
}

/** What one served free-chat turn reports on the spine — ids, counts and closed enums only. */
export interface FreeChatServed {
  readonly mode: FreeChatMode;
  readonly category: FreeChatCategory | null;
  readonly decidedBy: FreeChatDecidedBy;
  readonly confidenceBucket: CompanionV2ConfidenceBucket | null;
  readonly outcome: FreeChatOutcome;
  readonly refusalTopic: FreeChatRefusalTopic | null;
  readonly strikeCount: number | null;
  readonly cooldownStarted: boolean;
  readonly nudge: boolean;
}

/** One mode transition. `from` null is a session with no mode yet being stamped. */
export interface FreeChatModeChange {
  readonly from: FreeChatMode | null;
  readonly to: FreeChatMode;
  readonly trigger: FreeChatModeTrigger;
}

/** The attribution an event carries. `turnRef` makes the idempotency key unique per landed write. */
export interface FreeChatEventRef {
  readonly workerId: string;
  readonly sessionId: string;
  readonly submissionId: string | null;
  readonly turnRef: string;
  readonly ctx: RequestContext;
}

/**
 * THE PROFILING-STAGE FREE CHAT'S SIDE EFFECTS (ADR-0051) — the two model calls, their spend, the
 * two events and the durable lock. Everything that DECIDES is pure and lives in
 * `free-chat.router.ts`; the orchestrator calls this only for I/O.
 *
 * PRIVACY (ADR-0047). The worker's own known name is redacted out of every model input — the
 * message, the pending question and every recent turn — whatever `AI_RAW_PII_ENABLED` says (G2);
 * the ai-service then applies the masking policy in force. The events carry ids and closed enums,
 * never the worker's words or the model's. Every log line names ids and closed reasons only.
 *
 * NEVER FAILS A TURN. A model call that fails is "unavailable" (classify) or null (reply), which
 * the router turns into deterministic copy; a failed event or lock write is logged and swallowed —
 * the worker's reply is already decided.
 */
@Injectable()
export class FreeChatService {
  private readonly logger = new Logger(FreeChatService.name);

  constructor(
    private readonly ai: AiService,
    private readonly cost: AiCostRecorder,
    private readonly events: EventsService,
    private readonly chat: ChatRepository,
  ) {}

  /**
   * Classify one message. A REAL verdict needs `blocked === false`, `ai_metadata.real_call ===
   * true` and a call that did not fail; anything else — a mock, a blocked input, a timeout, a
   * schema miss, a null — is `unavailable` (ADR-0051 §3.2). The spend is recorded once, here,
   * before any branch: the caller memoises this promise per `takeTurn`, so a lost CAS never pays
   * twice.
   */
  async classify(req: FreeChatClassifyRequest, ctx: FreeChatCallContext): Promise<FreeChatVerdict> {
    const name = await this.knownNameOf(ctx);
    const input = FreeChatClassifyInputSchema.safeParse({
      text: clip(redactKnownName(req.text, name), CLASSIFY_TEXT_MAX),
      recent_turns: recentTurnsOf(req.messages, CLASSIFY_TURNS, name),
      mode: req.mode,
      pending_question: pendingQuestionOf(req.pendingQuestion, name),
    });
    if (!input.success) {
      this.logger.warn(
        `free-chat classify input off-contract session=${ctx.sessionId} ` +
          `paths=[${input.error.issues.map((i) => i.path.join(".")).join(",")}]; treated as unavailable`,
      );
      return UNAVAILABLE_VERDICT;
    }
    const out = await this.ai.freeChatClassify(input.data, ctx);
    await this.cost.record(
      out?.ai_metadata ?? null,
      "profiling_free_classify",
      null,
      ctx.correlationId,
      ctx.requestId,
      { workerId: ctx.workerId, sessionId: ctx.sessionId },
    );
    return verdictOf(out);
  }

  /**
   * One casual or career reply, or null when the call failed. The answer is UNTRUSTED: the caller
   * screens every line (`screenFreeChatAnswer`) before a worker reads it. The spend is recorded
   * once, here, before any branch — the same memoisation rule as {@link classify}.
   */
  async reply(
    req: FreeChatReplyRequest,
    ctx: FreeChatCallContext,
  ): Promise<FreeChatReplyOutput | null> {
    const name = await this.knownNameOf(ctx);
    const input = FreeChatReplyInputSchema.safeParse({
      category: req.category,
      text: clip(redactKnownName(req.text, name), REPLY_TEXT_MAX),
      recent_turns: recentTurnsOf(req.messages, REPLY_TURNS, name),
      worker_context: req.workerContext,
    });
    if (!input.success) {
      this.logger.warn(
        `free-chat reply input off-contract session=${ctx.sessionId} ` +
          `paths=[${input.error.issues.map((i) => i.path.join(".")).join(",")}]; the fallback line is served`,
      );
      return null;
    }
    const out = await this.ai.freeChatReply(input.data, ctx);
    await this.cost.record(
      out?.ai_metadata ?? null,
      "profiling_free_reply",
      null,
      ctx.correlationId,
      ctx.requestId,
      { workerId: ctx.workerId, sessionId: ctx.sessionId },
    );
    return out;
  }

  /**
   * `chat.free_chat_turn_served` — once per served free-chat turn, after the CAS that landed it.
   * Keyed on the submission (or the write's rev), so a retried emit stores one row. Never throws.
   */
  async recordServed(served: FreeChatServed, ref: FreeChatEventRef): Promise<void> {
    try {
      await this.events.emit({
        event_name: "chat.free_chat_turn_served",
        actor: { actor_type: "worker", actor_id: ref.workerId },
        subject: { subject_type: "chat_session", subject_id: ref.sessionId },
        payload: {
          worker_id: ref.workerId,
          session_id: ref.sessionId,
          mode: served.mode,
          category: served.category,
          decided_by: served.decidedBy,
          confidence_bucket: served.confidenceBucket,
          outcome: served.outcome,
          refusal_topic: served.refusalTopic,
          strike_count: served.strikeCount,
          cooldown_started: served.cooldownStarted,
          nudge: served.nudge,
          submission_id: ref.submissionId,
        },
        idempotencyKey: `chat.free_chat_turn_served:${ref.sessionId}:${ref.submissionId ?? ref.turnRef}`,
        correlationId: ref.ctx.correlationId,
        requestId: ref.ctx.requestId,
      });
    } catch (error) {
      this.logger.error(
        `chat.free_chat_turn_served not recorded session=${ref.sessionId} ` +
          `outcome=${served.outcome}: ${logSafeReason(error, "free-chat turn event")}`,
      );
    }
  }

  /**
   * `chat.free_chat_mode_changed` — once per transition. Keyed on the TARGET mode: a session enters
   * each mode at most once (the machine allows no way back), so the key dedupes a retried emit and
   * a re-decided turn alike. Never throws.
   */
  async recordModeChanged(change: FreeChatModeChange, ref: FreeChatEventRef): Promise<void> {
    try {
      await this.events.emit({
        event_name: "chat.free_chat_mode_changed",
        actor: { actor_type: "worker", actor_id: ref.workerId },
        subject: { subject_type: "chat_session", subject_id: ref.sessionId },
        payload: {
          worker_id: ref.workerId,
          session_id: ref.sessionId,
          from: change.from,
          to: change.to,
          trigger: change.trigger,
        },
        idempotencyKey: `chat.free_chat_mode_changed:${ref.sessionId}:${change.to}`,
        correlationId: ref.ctx.correlationId,
        requestId: ref.ctx.requestId,
      });
    } catch (error) {
      this.logger.error(
        `chat.free_chat_mode_changed not recorded session=${ref.sessionId} ` +
          `to=${change.to}: ${logSafeReason(error, "free-chat mode event")}`,
      );
    }
  }

  /**
   * Make the résumé lock DURABLE on this session's row (`ChatRepository.mergeFreeChatLock`). Best
   * effort, after the CAS: the envelope already holds the lock, and every replacing writer of the
   * column spreads it, so a failure here costs at most the cross-session lock of a session that is
   * then abandoned before its first checkpoint. Never throws.
   */
  async persistLock(sessionId: string, workerId: string, lockedAt: string): Promise<void> {
    try {
      await this.chat.mergeFreeChatLock(sessionId, workerId, lockedAt);
    } catch (error) {
      this.logger.warn(
        `free-chat lock not made durable session=${sessionId}; the envelope still holds it: ` +
          `${logSafeReason(error, "free-chat lock merge")}`,
      );
    }
  }

  /** The worker's own name for the G2 redaction — FAIL SAFE to null, logged with ids only. */
  private async knownNameOf(ctx: FreeChatCallContext): Promise<string | null> {
    try {
      return await ctx.knownName();
    } catch {
      this.logger.warn(
        `known name unavailable worker=${ctx.workerId} session=${ctx.sessionId}; ` +
          `this free-chat call is not name-redacted`,
      );
      return null;
    }
  }
}

/** A real verdict, or `unavailable` — see {@link FreeChatService.classify}. */
export function verdictOf(out: FreeChatClassifyOutput | null): FreeChatVerdict {
  if (out === null || out.blocked) return UNAVAILABLE_VERDICT;
  const meta = out.ai_metadata;
  if (meta === null || meta.real_call !== true || meta.success === false)
    return UNAVAILABLE_VERDICT;
  return { kind: "verdict", category: out.category, confidence: out.confidence };
}

/** `text` cut to at most `max` UTF-16 units without splitting a surrogate pair. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * The newest `limit` lines of the conversation as the contract's recent turns — the worker's
 * known name redacted, any `{{token}}` stripped, each clipped to the contract's bound, blank lines
 * dropped. IDENTITY-INTAKE LINES ARE NEVER SENT: a name or a town typed into a form question is
 * not conversation. Free-chat asides ARE sent — they are the conversation the model is answering.
 */
export function recentTurnsOf(
  messages: readonly BufferedMessage[],
  limit: number,
  knownName: string | null,
): CompanionRecentTurn[] {
  const turns: CompanionRecentTurn[] = [];
  for (const message of messages) {
    if (message.intake === true) continue;
    const text = clip(
      redactKnownName(message.text.replace(/\{\{[^}]*\}\}/g, ""), knownName).trim(),
      RECENT_TURN_MAX,
    ).trim();
    if (text.length === 0) continue;
    turns.push({ role: message.role === "worker" ? "worker" : "bada_bhai", text });
  }
  return turns.slice(-limit);
}

/** The pending question as the classifier reads it, or null when there is none. */
function pendingQuestionOf(question: string | null, knownName: string | null): string | null {
  if (question === null) return null;
  const text = clip(redactKnownName(question, knownName).trim(), PENDING_QUESTION_MAX).trim();
  return text.length > 0 ? text : null;
}

/**
 * The closed worker context the reply model may see (R16): the trade and an experience bucket,
 * when the interview has captured them — never a name or a city. The trade is the retrieval pin's
 * label (the universal placeholder "General" names no trade) or the worker's settled answer; the
 * bucket is the companion's 0-1 / 1-3 / 3-7 / 7+.
 */
export function freeChatWorkerContextOf(envelope: {
  readonly occupation: { readonly label: string } | null;
  readonly answerMap: readonly {
    readonly target_field: string | null;
    readonly value_normalized?: unknown;
    readonly status?: string;
  }[];
}): CompanionCareerWorkerContext {
  const pinned = envelope.occupation?.label ?? null;
  const settled = (field: string): unknown =>
    envelope.answerMap.find(
      (record) => record.target_field === field && record.status === "answered",
    )?.value_normalized;
  const tradeAnswer = settled("trade");
  const tradeRaw =
    pinned !== null && !isUniversalPlaceholderLabel(pinned)
      ? pinned
      : typeof tradeAnswer === "string"
        ? tradeAnswer
        : null;
  const trade = tradeRaw === null ? null : tradeRaw.trim().slice(0, TRADE_LABEL_MAX).trim();
  const years = settled("experience_years");
  return {
    trade_label: trade !== null && trade.length > 0 ? trade : null,
    experience_bucket: typeof years === "number" && Number.isFinite(years) ? bucketOf(years) : null,
  };
}

/** 0–1 / 1–3 / 3–7 / 7+ — the contract's closed buckets, lower bound inclusive. */
function bucketOf(years: number): CompanionCareerWorkerContext["experience_bucket"] {
  if (years < 1) return "0-1";
  if (years < 3) return "1-3";
  if (years < 7) return "3-7";
  return "7+";
}
