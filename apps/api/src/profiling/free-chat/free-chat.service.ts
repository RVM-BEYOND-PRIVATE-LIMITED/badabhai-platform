import { Injectable, Logger } from "@nestjs/common";

import {
  FreeChatClassifyInputSchema,
  FreeChatNewsInputSchema,
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
import { FREE_CHAT_SUMMARY_MAX } from "./free-chat-summary";
import { FreeChatNewsCap } from "./free-chat-news-cap.store";
import {
  carriesNewsIdentifier,
  judgeNews,
  keepsSlot,
  NEWS_NOT_REQUESTED,
  newsCapped,
  type FreeChatNewsCall,
  type FreeChatNewsResolution,
  type FreeChatNewsServed,
} from "./free-chat-news";
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
/**
 * ADR-0054 — how long a SETTLED news request stays shareable with a resent submission (see
 * `FreeChatService.requestNews`): a retry that lands just after the first request finished reuses
 * it instead of paying again.
 */
export const FREE_CHAT_NEWS_INFLIGHT_GRACE_MS = 60_000;
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
  /**
   * ADR-0051 §8 (Release 2) — the worker's stored rolling summary, or null. The REPLY alone gets it
   * (R24): the classifier's request has no such field.
   */
  readonly summary: string | null;
}

/**
 * One live-news call's inputs, before redaction (ADR-0054): the worker's question, the recent turns
 * the reply would see and the same closed worker context. No summary — the reply alone reads it.
 */
export interface FreeChatNewsRequest {
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
  /**
   * ADR-0054 — on a turn that ran a live-news request, what that request ended in: recorded as
   * `chat.free_chat_news_served` beside this turn's own event. ABSENT on every other turn.
   */
  readonly news?: FreeChatNewsServed;
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
 * THE PROFILING-STAGE FREE CHAT'S SIDE EFFECTS (ADR-0051) — the model calls, their spend, the
 * events and the durable lock; and (ADR-0054) the live-news call with its daily cap. Everything that
 * DECIDES is pure and lives in `free-chat.router.ts` and `free-chat-news.ts`; the orchestrator calls
 * this only for I/O.
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
  /** ADR-0054 — live-news requests in flight (and in their grace), by session and submission. */
  private readonly newsInFlight = new Map<string, Promise<FreeChatNewsResolution>>();

  constructor(
    private readonly ai: AiService,
    private readonly cost: AiCostRecorder,
    private readonly events: EventsService,
    private readonly chat: ChatRepository,
    // ADR-0054 — the live-news daily cap (Redis). A VALUE import, for the reason stated above.
    private readonly newsCap: FreeChatNewsCap,
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
      worker_context: workerContextFor(req.workerContext, name),
      summary: summaryForModel(req.summary, name),
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
   * ADR-0054 — ONE LIVE-NEWS CALL: whether it was SENT, and what came back (null on any failure).
   * The worker's own name (`knownName`, already looked up by the caller) is redacted out of the
   * question, every recent turn and the trade label (G2), exactly as for {@link reply}; a recent turn
   * carrying an identifier is dropped (R9, {@link newsTurnsOf}). An off-contract input is NOT sent.
   * The answer is UNTRUSTED: `judgeNews` checks every line and every source before a worker sees
   * them. The spend (tokens plus each search, priced by the ai-service) is recorded once, here.
   */
  async news(
    req: FreeChatNewsRequest,
    ctx: FreeChatCallContext,
    knownName: string | null,
  ): Promise<FreeChatNewsCall> {
    const input = FreeChatNewsInputSchema.safeParse({
      text: clip(redactKnownName(req.text, knownName), REPLY_TEXT_MAX),
      recent_turns: newsTurnsOf(req.messages, knownName),
      worker_context: workerContextFor(req.workerContext, knownName),
    });
    if (!input.success) {
      this.logger.warn(
        `free-chat news input off-contract session=${ctx.sessionId} ` +
          `paths=[${input.error.issues.map((i) => i.path.join(".")).join(",")}]; no news call is made`,
      );
      return { sent: false, output: null };
    }
    const out = await this.ai.freeChatNews(input.data, ctx);
    await this.cost.record(
      out?.ai_metadata ?? null,
      "profiling_free_news",
      null,
      ctx.correlationId,
      ctx.requestId,
      { workerId: ctx.workerId, sessionId: ctx.sessionId },
    );
    return { sent: true, output: out };
  }

  /**
   * ONE LIVE-NEWS REQUEST, END TO END (ADR-0054 §3.1, §8) — SHARED by every concurrent turn of the
   * same submission.
   *
   * THE APP RESENDS A SLOW SUBMISSION. It times `POST /chat/message` out at 15 s and resends the same
   * `submission_id` while the first request is still running (a news turn takes 8-15 s); the second
   * `takeTurn` builds its own refs, so without this it would reserve a second slot and pay for a
   * second search. Keyed `${sessionId}:${submissionId}`, the request (reservation and call together)
   * is held while in flight and for {@link FREE_CHAT_NEWS_INFLIGHT_GRACE_MS} after it settles, so a
   * retry that lands right after completion reuses it too. A turn with no submission id (an older
   * app) is not shared — the reply cache has nothing to match it by either.
   *
   * PROCESS-LOCAL. One API container today; with more than one, a retry routed to another instance
   * would run its own request (bounded by the daily cap). A Redis-held lock is the fix then.
   */
  requestNews(
    req: FreeChatNewsRequest,
    ctx: FreeChatCallContext,
    now: Date,
    submissionId: string | null,
  ): Promise<FreeChatNewsResolution> {
    if (submissionId === null) return this.runNewsRequest(req, ctx, now);
    const key = `${ctx.sessionId}:${submissionId}`;
    const held = this.newsInFlight.get(key);
    if (held !== undefined) return held;
    const request = this.runNewsRequest(req, ctx, now);
    this.newsInFlight.set(key, request);
    const forget = (): void => {
      const timer = setTimeout(() => {
        if (this.newsInFlight.get(key) === request) this.newsInFlight.delete(key);
      }, FREE_CHAT_NEWS_INFLIGHT_GRACE_MS);
      timer.unref();
    };
    void request.then(forget, forget);
    return request;
  }

  /**
   * The request itself. In order, and the order is the design:
   *
   *   1. THE WORKER'S OWN NAME (G2). A lookup that ERRORS — not "no name on file" — means the
   *      question cannot be redacted: no reservation, no call, the unavailable line.
   *   2. AN IDENTIFIER IN THE QUESTION (R9): a phone number, an email or an ID number is never
   *      searched — no reservation, no call, the unavailable line.
   *   3. THE CAP: an unreadable store makes no call (fail closed); a spent one serves NEWS_CAP.
   *   4. THE CALL, judged by `judgeNews`.
   *   5. THE SLOT (R5 as revised): KEPT for every request that may have reached Anthropic, handed back
   *      only when it certainly did not (`keepsSlot`).
   *
   * `now` is the TURN's clock, so the release rebuilds the key the reservation used. Never throws:
   * anything unexpected is the unavailable line, and a slot already taken is kept (fail closed).
   */
  private async runNewsRequest(
    req: FreeChatNewsRequest,
    ctx: FreeChatCallContext,
    now: Date,
  ): Promise<FreeChatNewsResolution> {
    try {
      const own = await this.ownNameForNews(ctx);
      if (!own.ok) return NEWS_NOT_REQUESTED;
      if (carriesNewsIdentifier(req.text)) {
        // Ids only: the question is the worker's own text and carries the identifier.
        this.logger.log(
          `free-chat news question carries an identifier session=${ctx.sessionId}; it is not searched`,
        );
        return NEWS_NOT_REQUESTED;
      }
      const slot = await this.newsCap.reserve(ctx.workerId, now);
      if (slot === null) return NEWS_NOT_REQUESTED;
      if (!slot.ok) return newsCapped(slot.count);
      const call = await this.news(req, ctx, own.name).catch((error: unknown) => {
        this.logger.warn(
          `free-chat news call threw session=${ctx.sessionId}; judged as no answer, slot kept: ` +
            `${logSafeReason(error, "free-chat news call")}`,
        );
        // It may have been sent: keep the slot (the fail-closed direction).
        return { sent: true, output: null } satisfies FreeChatNewsCall;
      });
      const verdict = judgeNews(call.output);
      if (verdict.outcome !== "answered" && verdict.rejection !== null) {
        // The CLOSED reason only — never a line of the answer or a source, which are untrusted text.
        this.logger.warn(
          `free-chat news answer rejected session=${ctx.sessionId} (${verdict.rejection}); ` +
            `the unavailable line is served`,
        );
      }
      if (keepsSlot(call)) return { ...verdict, dailyCount: slot.count };
      await this.newsCap.release(ctx.workerId, now);
      return { ...verdict, dailyCount: slot.count - 1 };
    } catch (error) {
      this.logger.error(
        `free-chat news request failed session=${ctx.sessionId}; the unavailable line is served: ` +
          `${logSafeReason(error, "free-chat news request")}`,
      );
      return NEWS_NOT_REQUESTED;
    }
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
   * ADR-0054 (security M1) — the worker's own name for a NEWS call, which FAILS CLOSED where
   * {@link knownNameOf} fails open: a lookup that errors is `{ok: false}` and no news request is
   * made, because an unredacted question would reach a third-party search. "No name on file" is
   * `{ok: true, name: null}` — nothing to redact. Classify and reply keep the fail-open lookup.
   */
  private async ownNameForNews(
    ctx: FreeChatCallContext,
  ): Promise<{ readonly ok: true; readonly name: string | null } | { readonly ok: false }> {
    try {
      return { ok: true, name: await ctx.knownName() };
    } catch {
      this.logger.warn(
        `known name unavailable worker=${ctx.workerId} session=${ctx.sessionId}; ` +
          `no news request is made (it could not be name-redacted)`,
      );
      return { ok: false };
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
    const turn = recentTurnOf(message, knownName);
    if (turn !== null) turns.push(turn);
  }
  return turns.slice(-limit);
}

/**
 * ADR-0054 — the recent turns a NEWS call carries: the reply's window ({@link REPLY_TURNS}, the same
 * redaction and clipping as {@link recentTurnsOf}) MINUS every turn whose text carries an
 * identifier (R9, `carriesNewsIdentifier`), so a number typed two turns ago plus "aur batao" can
 * never reach a search query.
 */
export function newsTurnsOf(
  messages: readonly BufferedMessage[],
  knownName: string | null,
): CompanionRecentTurn[] {
  const window: Array<{ readonly source: BufferedMessage; readonly turn: CompanionRecentTurn }> =
    [];
  for (const message of messages) {
    const turn = recentTurnOf(message, knownName);
    if (turn !== null) window.push({ source: message, turn });
  }
  return window
    .slice(-REPLY_TURNS)
    .filter(
      ({ source, turn }) =>
        !carriesNewsIdentifier(source.text) && !carriesNewsIdentifier(turn.text),
    )
    .map(({ turn }) => turn);
}

/**
 * ONE line as a contract turn, or null when it is never sent — an identity-intake line, or one that
 * is blank once its `{{token}}`s are stripped. The worker's known name is redacted and the text
 * clipped to the contract's bound. {@link recentTurnsOf} is this over a conversation, and the
 * rolling summary's window and fold (`free-chat-summary.service.ts`) use it too, so "a line the
 * reply sees" has one definition.
 */
export function recentTurnOf(
  message: BufferedMessage,
  knownName: string | null,
): CompanionRecentTurn | null {
  if (message.intake === true) return null;
  const text = clip(
    redactKnownName(message.text.replace(/\{\{[^}]*\}\}/g, ""), knownName).trim(),
    RECENT_TURN_MAX,
  ).trim();
  if (text.length === 0) return null;
  return { role: message.role === "worker" ? "worker" : "bada_bhai", text };
}

/**
 * A stored rolling summary as a model input (ADR-0051 §8): the worker's own name redacted AGAIN at
 * the egress (G2 — the name may have changed since the summary was screened), trimmed and clipped
 * to the contract's bound; null when there is none or nothing is left. Shared by the reply's
 * `summary` and the fold's `previous_summary`, so neither can carry a value the contract rejects —
 * an off-contract summary must cost the reply its continuity, never the reply.
 */
export function summaryForModel(summary: string | null, knownName: string | null): string | null {
  if (summary === null) return null;
  const text = clip(redactKnownName(summary, knownName).trim(), FREE_CHAT_SUMMARY_MAX).trim();
  return text.length > 0 ? text : null;
}

/**
 * The worker context with the worker's own name redacted out of the trade label (G2): the label
 * is a retrieval pin or the worker's settled answer, and a worker who typed his name as his trade
 * must not hand it to the model through this field either.
 */
function workerContextFor(
  context: CompanionCareerWorkerContext,
  knownName: string | null,
): CompanionCareerWorkerContext {
  if (context.trade_label === null) return context;
  const label = clip(
    redactKnownName(context.trade_label, knownName).trim(),
    TRADE_LABEL_MAX,
  ).trim();
  return { ...context, trade_label: label.length > 0 ? label : null };
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
