import { Injectable, Logger } from "@nestjs/common";

import {
  FREE_CHAT_RESUME_FACTS_MAX,
  FreeChatClassifyInputSchema,
  FreeChatNewsInputSchema,
  FreeChatReplyInputSchema,
  type CompanionCareerWorkerContext,
  type CompanionEditSnapshotRow,
  type CompanionRecentTurn,
  type FreeChatClassifyMode,
  type FreeChatClassifyOutput,
  type FreeChatReplyOutput,
} from "@badabhai/ai-contracts";
import type {
  FreeChatReplyCategory,
  FreeChatReplyLanguage,
  FreeChatResumeAction,
  FreeChatSurface,
} from "@badabhai/types";

// VALUE imports, not `import type`: each is a constructor parameter, and Nest resolves them from
// the emitted `design:paramtypes` — a type-only import would leave this service unwired at boot.
import { AiCostRecorder } from "../../ai/ai-cost-recorder.service";
import { AiService } from "../../ai/ai.service";
import { logSafeReason } from "../../common/db-error";
import { redactKnownName, type KnownNameSource } from "../../common/redact-known-name";
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
 * `FreeChatModelCalls.requestNews`): a retry that lands just after the first request finished
 * reuses it instead of paying again.
 */
export const FREE_CHAT_NEWS_INFLIGHT_GRACE_MS = 60_000;
/** The worker context's trade-label bound (`CompanionCareerWorkerContextSchema.trade_label`). */
export const TRADE_LABEL_MAX = 64;
/**
 * #2304 — one résumé fact value as the reply reads it. The contract leaves a snapshot value
 * unbounded (the edit parse sends whole values); a reply needs the gist, and forty rows of whole
 * work descriptions would crowd out the conversation.
 */
export const RESUME_FACT_VALUE_MAX = 200;

/** Who one model call belongs to — ids and the request's correlation only. */
export interface FreeChatCallContext {
  readonly workerId: string;
  /**
   * The profiling chat session the call serves, or null on a surface that has no session — the Bada
   * Bhai chat after the profile is confirmed (ADR-0055), which never reads or writes a chat session.
   */
  readonly sessionId: string | null;
  readonly correlationId: string;
  readonly requestId: string;
  /** The worker's own name, for the G2 redaction — a thunk, read only by a call that is made. */
  readonly knownName: KnownNameSource;
  /**
   * ADR-0055 — the screen the call serves, handed to every AI input as `surface`. Absent = the
   * contract's default (`profiling`), so every profiling caller's input is exactly what it was.
   */
  readonly surface?: FreeChatSurface;
}

/**
 * One line of the conversation as a model call reads it. A profiling transcript line
 * (`BufferedMessage`) is one; so is a companion memory turn, through {@link contextLinesOf}.
 */
export interface FreeChatContextLine {
  readonly role: "worker" | "assistant";
  readonly text: string;
  /** An identity-intake line (ADR-0048) — never sent to a model. */
  readonly intake?: true;
}

/** One classifier call's inputs, before redaction. */
export interface FreeChatClassifyRequest {
  readonly text: string;
  readonly mode: FreeChatClassifyMode;
  /** The interview question on screen (résumé mode); null in free mode. */
  readonly pendingQuestion: string | null;
  readonly messages: readonly FreeChatContextLine[];
}

/** One reply call's inputs, before redaction. */
export interface FreeChatReplyRequest {
  readonly category: FreeChatReplyCategory;
  readonly text: string;
  readonly messages: readonly FreeChatContextLine[];
  readonly workerContext: CompanionCareerWorkerContext;
  /**
   * ADR-0051 §8 (Release 2) — the worker's stored rolling summary, or null. The REPLY alone gets it
   * (R24): the classifier's request has no such field.
   */
  readonly summary: string | null;
  /**
   * ADR-0051 §11 (R39) — the language CODE decided this reply is written in: an explicit request,
   * the kept language, or the message's own. REQUIRED, never optional: a call site that forgot it
   * would silently hand the choice back to the model, the defect §11 exists to fix. Null leaves the
   * prompt's own rules in force; the free chat's turns always decide one.
   */
  readonly replyLanguage: FreeChatReplyLanguage | null;
  /**
   * #2304 — what the worker's résumé says (the edit snapshot's rows), on the Bada Bhai chat only,
   * so a question about their own résumé is answered from it. REQUIRED for the same reason as
   * `replyLanguage`: the profiling chat passes null on purpose, never by omission. Stored values,
   * so the worker's own name is redacted out of each one here (G2) and the AI-service masks them.
   */
  readonly resumeFacts: readonly CompanionEditSnapshotRow[] | null;
}

/**
 * One live-news call's inputs, before redaction (ADR-0054): the worker's question, the recent turns
 * the reply would see and the same closed worker context. No summary — the reply alone reads it.
 */
export interface FreeChatNewsRequest {
  readonly text: string;
  readonly messages: readonly FreeChatContextLine[];
  readonly workerContext: CompanionCareerWorkerContext;
  /** ADR-0051 §11 — the reply's language, handed on: a news answer is written in it too. */
  readonly replyLanguage: FreeChatReplyLanguage | null;
}

/**
 * ADR-0055 — one classification as the Bada Bhai chat reads it: the verdict, plus what a `resume`
 * message wants. `resumeAction` is null on every other category and on an unavailable verdict.
 */
export interface FreeChatClassification {
  readonly verdict: FreeChatVerdict;
  readonly resumeAction: FreeChatResumeAction | null;
}

/**
 * THE FREE CHAT'S MODEL CALLS (ADR-0051, ADR-0054) — classify, reply and live news, with their spend
 * and the news daily cap. Split out of `FreeChatService` for ADR-0055 (#2275): the Bada Bhai chat
 * runs the same brain, and its module may not reach the chat repository `FreeChatService` writes
 * through. So this class depends only on the AI client, the cost recorder and the news cap, and the
 * companion module provides it on its own. `FreeChatService` IS this class plus the profiling chat's
 * events and durable writes — its methods, its log context and its constructor are unchanged.
 *
 * PRIVACY (ADR-0047). The worker's own known name is redacted out of every model input — the
 * message, the pending question and every recent turn — whatever `AI_RAW_PII_ENABLED` says (G2);
 * the ai-service then applies the masking policy in force. Every log line names ids and closed
 * reasons only.
 *
 * NEVER FAILS A TURN. A model call that fails is "unavailable" (classify) or null (reply), which
 * the caller turns into deterministic copy.
 */
@Injectable()
export class FreeChatModelCalls {
  /**
   * Named after the RUNTIME class, so `FreeChatService`'s lines keep the `FreeChatService` context
   * they always had (log searches keep working), and the companion's read `FreeChatModelCalls`.
   */
  protected readonly logger = new Logger(this.constructor.name);
  /** ADR-0054 — live-news requests in flight (and in their grace), by session and submission. */
  private readonly newsInFlight = new Map<string, Promise<FreeChatNewsResolution>>();

  constructor(
    protected readonly ai: AiService,
    protected readonly cost: AiCostRecorder,
    // ADR-0054 — the live-news daily cap (Redis). A VALUE import, for the reason stated above.
    protected readonly newsCap: FreeChatNewsCap,
  ) {}

  /**
   * Classify one message. A REAL verdict needs `blocked === false`, `ai_metadata.real_call ===
   * true` and a call that did not fail; anything else — a mock, a blocked input, a timeout, a
   * schema miss, a null — is `unavailable` (ADR-0051 §3.2). A real verdict also carries the
   * message's language label (§11 R42). The spend is recorded once, here, before any branch: the
   * caller memoises this promise per `takeTurn`, so a lost CAS never pays twice — nor re-asks the
   * language.
   */
  async classify(req: FreeChatClassifyRequest, ctx: FreeChatCallContext): Promise<FreeChatVerdict> {
    return verdictOf(await this.classifyOutput(req, ctx));
  }

  /**
   * ADR-0055 — {@link classify}, plus the classifier's `resume_action`: what a `resume` message
   * wants on the Bada Bhai chat (edit / new / download). ONE call, recorded once. The action is
   * read only off a REAL `resume` verdict, so an unavailable classifier or another category can
   * never contribute one.
   */
  async classifyWithAction(
    req: FreeChatClassifyRequest,
    ctx: FreeChatCallContext,
  ): Promise<FreeChatClassification> {
    const out = await this.classifyOutput(req, ctx);
    const verdict = verdictOf(out);
    const resumeAction =
      verdict.kind === "verdict" && verdict.category === "resume"
        ? (out?.resume_action ?? null)
        : null;
    return { verdict, resumeAction };
  }

  /** The classifier's output, or null when the input was off-contract (no call is made then). */
  private async classifyOutput(
    req: FreeChatClassifyRequest,
    ctx: FreeChatCallContext,
  ): Promise<FreeChatClassifyOutput | null> {
    const name = await this.knownNameOf(ctx);
    const input = FreeChatClassifyInputSchema.safeParse({
      text: clip(redactKnownName(req.text, name), CLASSIFY_TEXT_MAX),
      recent_turns: recentTurnsOf(req.messages, CLASSIFY_TURNS, name),
      mode: req.mode,
      pending_question: pendingQuestionOf(req.pendingQuestion, name),
      surface: ctx.surface,
    });
    if (!input.success) {
      this.logger.warn(
        `free-chat classify input off-contract ${callRefOf(ctx)} ` +
          `paths=[${input.error.issues.map((i) => i.path.join(".")).join(",")}]; treated as unavailable`,
      );
      return null;
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
    return out;
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
      reply_language: req.replyLanguage,
      surface: ctx.surface,
      resume_facts: resumeFactsForModel(req.resumeFacts, name),
    });
    if (!input.success) {
      this.logger.warn(
        `free-chat reply input off-contract ${callRefOf(ctx)} ` +
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
      // ADR-0054 §8 (H2): the worker's id, so the ai-service's per-worker daily AI spend limit
      // (`ai_max_user_daily_cost_inr`) bounds news on top of the API's daily attempt cap. The
      // ai-service uses it for the spend ledger only; it never reaches the model.
      worker_ref: ctx.workerId,
      // ADR-0051 §11 — the language the reply that handed over to news was to be written in.
      reply_language: req.replyLanguage,
      surface: ctx.surface,
    });
    if (!input.success) {
      this.logger.warn(
        `free-chat news input off-contract ${callRefOf(ctx)} ` +
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
   * second search. Keyed `${sessionId}:${submissionId}` — or, on a surface with no session (ADR-0055,
   * the Bada Bhai chat), `worker:${workerId}:${submissionId}` — the request (reservation and call
   * together) is held while in flight and for {@link FREE_CHAT_NEWS_INFLIGHT_GRACE_MS} after it
   * settles, so a retry that lands right after completion reuses it too. A turn with no submission
   * id (an older app) is not shared — the reply cache has nothing to match it by either.
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
    const key =
      ctx.sessionId === null
        ? `worker:${ctx.workerId}:${submissionId}`
        : `${ctx.sessionId}:${submissionId}`;
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
          `free-chat news question carries an identifier ${callRefOf(ctx)}; it is not searched`,
        );
        return NEWS_NOT_REQUESTED;
      }
      const slot = await this.newsCap.reserve(ctx.workerId, now);
      if (slot === null) return NEWS_NOT_REQUESTED;
      if (!slot.ok) return newsCapped(slot.count);
      const call = await this.news(req, ctx, own.name).catch((error: unknown) => {
        this.logger.warn(
          `free-chat news call threw ${callRefOf(ctx)}; judged as no answer, slot kept: ` +
            `${logSafeReason(error, "free-chat news call")}`,
        );
        // It may have been sent: keep the slot (the fail-closed direction).
        return { sent: true, output: null } satisfies FreeChatNewsCall;
      });
      const verdict = judgeNews(call.output);
      if (verdict.outcome !== "answered" && verdict.rejection !== null) {
        // The CLOSED reason only — never a line of the answer or a source, which are untrusted text.
        this.logger.warn(
          `free-chat news answer rejected ${callRefOf(ctx)} (${verdict.rejection}); ` +
            `the unavailable line is served`,
        );
      }
      if (keepsSlot(call)) return { ...verdict, dailyCount: slot.count };
      await this.newsCap.release(ctx.workerId, now);
      return { ...verdict, dailyCount: slot.count - 1 };
    } catch (error) {
      this.logger.error(
        `free-chat news request failed ${callRefOf(ctx)}; the unavailable line is served: ` +
          `${logSafeReason(error, "free-chat news request")}`,
      );
      return NEWS_NOT_REQUESTED;
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
        `known name unavailable ${workerRefOf(ctx)}; ` +
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
        `known name unavailable ${workerRefOf(ctx)}; ` + `this free-chat call is not name-redacted`,
      );
      return null;
    }
  }
}

/**
 * The ids a log line names for one call: the session, as every profiling line always has — or, on
 * a surface with no session (ADR-0055), the worker. Ids only, never text.
 */
function callRefOf(ctx: FreeChatCallContext): string {
  return ctx.sessionId === null ? `worker=${ctx.workerId}` : `session=${ctx.sessionId}`;
}

/** `worker=… session=…`, the session left out where there is none. */
function workerRefOf(ctx: FreeChatCallContext): string {
  return ctx.sessionId === null
    ? `worker=${ctx.workerId}`
    : `worker=${ctx.workerId} session=${ctx.sessionId}`;
}

/**
 * A real verdict, or `unavailable` — see {@link FreeChatModelCalls.classify}. A real verdict carries
 * the classifier's language label (ADR-0051 R42); a missing one reads as null, so a body that never
 * met the schema's default (an older service's shape) leaves the word lists in force.
 */
export function verdictOf(out: FreeChatClassifyOutput | null): FreeChatVerdict {
  if (out === null || out.blocked) return UNAVAILABLE_VERDICT;
  const meta = out.ai_metadata;
  if (meta === null || meta.real_call !== true || meta.success === false)
    return UNAVAILABLE_VERDICT;
  return {
    kind: "verdict",
    category: out.category,
    confidence: out.confidence,
    language: out.language ?? null,
  };
}

/**
 * ADR-0055 — the Bada Bhai chat's memory turns (`CompanionMemoryStore`, oldest first) as the lines a
 * model call reads: the worker's as `worker`, Bada Bhai's as `assistant`. No line is an intake line.
 */
export function contextLinesOf(turns: readonly CompanionRecentTurn[]): FreeChatContextLine[] {
  return turns.map((turn) => ({
    role: turn.role === "worker" ? "worker" : "assistant",
    text: turn.text,
  }));
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
  messages: readonly FreeChatContextLine[],
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
  messages: readonly FreeChatContextLine[],
  knownName: string | null,
): CompanionRecentTurn[] {
  const window: Array<{
    readonly source: FreeChatContextLine;
    readonly turn: CompanionRecentTurn;
  }> = [];
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
  message: FreeChatContextLine,
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
 * #2304 — the résumé's rows as the reply's `resume_facts`: the worker's own name redacted out of
 * every value (G2 — an employer or a work description may carry it), any `{{token}}` stripped, each
 * value clipped to {@link RESUME_FACT_VALUE_MAX}, a value left blank nulled, and at most the
 * contract's {@link FREE_CHAT_RESUME_FACTS_MAX} rows. Null for none: the reply then runs as before.
 */
export function resumeFactsForModel(
  rows: readonly CompanionEditSnapshotRow[] | null | undefined,
  knownName: string | null,
): CompanionEditSnapshotRow[] | null {
  // `undefined` too (a caller built without the type, e.g. a test double): no facts, never a throw.
  if (rows == null || rows.length === 0) return null;
  return rows.slice(0, FREE_CHAT_RESUME_FACTS_MAX).map((row) => ({
    ref: row.ref,
    section: row.section,
    fields: Object.fromEntries(
      Object.entries(row.fields).map(([field, value]) => {
        if (value === null) return [field, null];
        const text = clip(
          redactKnownName(value.replace(/\{\{[^}]*\}\}/g, ""), knownName).trim(),
          RESUME_FACT_VALUE_MAX,
        ).trim();
        return [field, text.length > 0 ? text : null];
      }),
    ),
  }));
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
