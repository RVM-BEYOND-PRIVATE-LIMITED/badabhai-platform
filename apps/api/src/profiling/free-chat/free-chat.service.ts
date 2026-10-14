import { Injectable } from "@nestjs/common";

import type { CompanionCareerWorkerContext } from "@badabhai/ai-contracts";
import type {
  CompanionV2ConfidenceBucket,
  FreeChatCategory,
  FreeChatDecidedBy,
  FreeChatLanguageTrigger,
  FreeChatMode,
  FreeChatModeTrigger,
  FreeChatOutcome,
  FreeChatRefusalTopic,
  FreeChatReplyLanguage,
} from "@badabhai/types";

// VALUE imports, not `import type`: each is a constructor parameter, and Nest resolves them from
// the emitted `design:paramtypes` — a type-only import would leave this service unwired at boot.
import { AiCostRecorder } from "../../ai/ai-cost-recorder.service";
import { AiService } from "../../ai/ai.service";
import { ChatRepository } from "../../chat/chat.repository";
import { logSafeReason } from "../../common/db-error";
import type { RequestContext } from "../../common/request-context";
import { EventsService } from "../../events/events.service";
import { isUniversalPlaceholderLabel } from "../../occupation/family-chip-labels";
import { FreeChatNewsCap } from "./free-chat-news-cap.store";
import type { FreeChatNewsServed } from "./free-chat-news";
import { FreeChatModelCalls, TRADE_LABEL_MAX } from "./free-chat-model-calls";
import { freeChatLanguageRecord, readFreeChatLanguageValue } from "./free-chat.state";

// ADR-0055 (#2275) — the model calls moved to `free-chat-model-calls.ts` (the Bada Bhai chat
// provides them without this class's chat-repository writes). Re-exported, so every existing import
// of these names from this module is unchanged.
export {
  CLASSIFY_TEXT_MAX,
  CLASSIFY_TURNS,
  FREE_CHAT_NEWS_INFLIGHT_GRACE_MS,
  REPLY_TEXT_MAX,
  REPLY_TURNS,
  newsTurnsOf,
  recentTurnOf,
  recentTurnsOf,
  summaryForModel,
  verdictOf,
} from "./free-chat-model-calls";
export type {
  FreeChatCallContext,
  FreeChatClassifyRequest,
  FreeChatContextLine,
  FreeChatNewsRequest,
  FreeChatReplyRequest,
} from "./free-chat-model-calls";

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
  /**
   * ADR-0054 — on a turn that ran a live-news request, what that request ended in: recorded as
   * `chat.free_chat_news_served` beside this turn's own event. ABSENT on every other turn.
   */
  readonly news?: FreeChatNewsServed;
  /**
   * ADR-0051 §11 — on a turn whose answered ask CHANGED the kept reply language, the change:
   * recorded as `chat.free_chat_language_changed` and merge-written onto the session's row, after
   * the CAS. ABSENT on every other turn — an answer that changes nothing records nothing.
   */
  readonly language?: FreeChatLanguageChange;
}

/** One mode transition. `from` null is a session with no mode yet being stamped. */
export interface FreeChatModeChange {
  readonly from: FreeChatMode | null;
  readonly to: FreeChatMode;
  readonly trigger: FreeChatModeTrigger;
}

/**
 * One change of the kept reply language (ADR-0051 §11, R41). `accepted` always lands on a language,
 * `declined` always on null — the event's own refines.
 */
export interface FreeChatLanguageChange {
  readonly from: FreeChatReplyLanguage | null;
  readonly to: FreeChatReplyLanguage | null;
  readonly trigger: FreeChatLanguageTrigger;
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
 * THE PROFILING-STAGE FREE CHAT'S SIDE EFFECTS (ADR-0051) — the model calls, their spend, the
 * events, the durable lock and (§11) the kept reply language; and (ADR-0054) the live-news call
 * with its daily cap. Everything that
 * DECIDES is pure and lives in `free-chat.router.ts` and `free-chat-news.ts`; the orchestrator calls
 * this only for I/O.
 *
 * THE MODEL CALLS ARE INHERITED (ADR-0055, #2275): `classify`, `reply`, `news` and `requestNews`
 * live in {@link FreeChatModelCalls}, which the Bada Bhai chat provides on its own. This class adds
 * only what the profiling chat owns — its events and its writes to the chat session row — so its
 * constructor, its methods and its log context are exactly what they were.
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
export class FreeChatService extends FreeChatModelCalls {
  constructor(
    ai: AiService,
    cost: AiCostRecorder,
    private readonly events: EventsService,
    private readonly chat: ChatRepository,
    // ADR-0054 — the live-news daily cap (Redis). A VALUE import, for the reason stated above.
    newsCap: FreeChatNewsCap,
  ) {
    super(ai, cost, newsCap);
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
   * `chat.free_chat_news_served` (ADR-0054 §3.5) — once per news request that LANDED, after the CAS,
   * beside the turn's own `chat.free_chat_turn_served`. Counts and closed enums only: never the
   * question, the answer, a URL or a title. Keyed like the turn's event. Never throws.
   */
  async recordNews(news: FreeChatNewsServed, ref: FreeChatEventRef): Promise<void> {
    try {
      await this.events.emit({
        event_name: "chat.free_chat_news_served",
        actor: { actor_type: "worker", actor_id: ref.workerId },
        subject: { subject_type: "chat_session", subject_id: ref.sessionId },
        payload: {
          worker_id: ref.workerId,
          session_id: ref.sessionId,
          outcome: news.outcome,
          kind: news.kind,
          search_count: news.searchCount,
          source_count: news.sourceCount,
          daily_count: news.dailyCount,
          submission_id: ref.submissionId,
        },
        idempotencyKey: `chat.free_chat_news_served:${ref.sessionId}:${ref.submissionId ?? ref.turnRef}`,
        correlationId: ref.ctx.correlationId,
        requestId: ref.ctx.requestId,
      });
    } catch (error) {
      this.logger.error(
        `chat.free_chat_news_served not recorded session=${ref.sessionId} ` +
          `outcome=${news.outcome}: ${logSafeReason(error, "free-chat news event")}`,
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

  /**
   * `chat.free_chat_language_changed` (ADR-0051 §11) — once per answered ask that CHANGED the kept
   * reply language, after the CAS. Ids and closed enums only. Keyed like the turn's own event, so a
   * retried emit stores one row. Never throws.
   */
  async recordLanguageChanged(
    change: FreeChatLanguageChange,
    ref: FreeChatEventRef,
  ): Promise<void> {
    try {
      await this.events.emit({
        event_name: "chat.free_chat_language_changed",
        actor: { actor_type: "worker", actor_id: ref.workerId },
        subject: { subject_type: "chat_session", subject_id: ref.sessionId },
        payload: {
          worker_id: ref.workerId,
          session_id: ref.sessionId,
          from: change.from,
          to: change.to,
          trigger: change.trigger,
        },
        idempotencyKey: `chat.free_chat_language_changed:${ref.sessionId}:${ref.submissionId ?? ref.turnRef}`,
        correlationId: ref.ctx.correlationId,
        requestId: ref.ctx.requestId,
      });
    } catch (error) {
      this.logger.error(
        `chat.free_chat_language_changed not recorded session=${ref.sessionId} ` +
          `trigger=${change.trigger}: ${logSafeReason(error, "free-chat language event")}`,
      );
    }
  }

  /**
   * Make the kept reply language DURABLE (ADR-0051 §11): the `free_chat_language` record, merged
   * onto this session's row (`ChatRepository.mergeFreeChatLanguage`), so the worker's next session
   * opens with it. Best effort, after the CAS: the envelope already holds it for this session, so a
   * failure costs only the carry to the next one. Never throws.
   */
  async persistLanguage(
    sessionId: string,
    workerId: string,
    language: FreeChatReplyLanguage | null,
    at: Date,
  ): Promise<void> {
    try {
      await this.chat.mergeFreeChatLanguage(
        sessionId,
        workerId,
        freeChatLanguageRecord(language, at, sessionId),
      );
    } catch (error) {
      this.logger.warn(
        `free-chat language not made durable session=${sessionId}; this session still holds it: ` +
          `${logSafeReason(error, "free-chat language merge")}`,
      );
    }
  }

  /**
   * The reply language the worker last chose to keep (ADR-0051 §11) — the latest SET record across
   * their sessions, a decline included — or null. Read once per new free chat, at its greeting.
   * FAILS SOFT: an unreadable store or record is "none kept" (each reply follows the message), logged
   * with ids only. Never throws.
   */
  async keptLanguage(workerId: string, sessionId: string): Promise<FreeChatReplyLanguage | null> {
    try {
      const latest = await this.chat.findLatestFreeChatLanguage(workerId);
      return readFreeChatLanguageValue(latest?.language)?.language ?? null;
    } catch (error) {
      this.logger.warn(
        `free-chat kept language unreadable session=${sessionId}; each reply follows the message: ` +
          `${logSafeReason(error, "free-chat language read")}`,
      );
      return null;
    }
  }
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
