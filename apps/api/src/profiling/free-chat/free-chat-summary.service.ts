import { Injectable, Logger } from "@nestjs/common";

import {
  FreeChatSummarizeInputSchema,
  type CompanionRecentTurn,
  type FreeChatSummarizeOutput,
} from "@badabhai/ai-contracts";
import type { FreeChatSummaryOutcome } from "@badabhai/types";

// VALUE imports, not `import type`: each is a constructor parameter, and Nest resolves them from
// the emitted `design:paramtypes` — a type-only import would leave this service unwired at boot.
import { AiCostRecorder } from "../../ai/ai-cost-recorder.service";
import { AiService } from "../../ai/ai.service";
import { ChatRepository } from "../../chat/chat.repository";
import type { BufferedMessage } from "../../chat/chat-transcript.buffer";
import { logSafeReason } from "../../common/db-error";
import type { KnownNameSource } from "../../common/redact-known-name";
import { EventsService } from "../../events/events.service";
import { FREE_CHAT_COPY_ENTRIES } from "./free-chat.copy";
import { FreeChatFoldLock } from "./free-chat-fold.lock";
import {
  FREE_CHAT_FOLD_MAX_LINES,
  FREE_CHAT_FOLD_MIN_LINES,
  carriesHardIdentifier,
  foldWatermarkOf,
  readFreeChatSummary,
  readFreeChatSummaryValue,
  screenFreeChatSummary,
  summaryTextOf,
  type FreeChatSummary,
} from "./free-chat-summary";
import { REPLY_TURNS, recentTurnOf, summaryForModel } from "./free-chat.service";

/**
 * One fold's inputs, captured when the reply's CAS landed. Ids, the request's correlation, the
 * worker's name THUNK (for G2 — read only if the fold reaches the model) and the transcript that
 * was written. Never logged, never evented.
 */
export interface FreeChatFoldJob {
  readonly workerId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly requestId: string;
  readonly knownName: KnownNameSource;
  /** The transcript as it LANDED with the reply — the fold reads nothing newer or older. */
  readonly messages: readonly BufferedMessage[];
  /**
   * This session's folded count as the REQUEST's own row read saw it — a LOWER BOUND (the count
   * only grows), so {@link FreeChatSummaryService.schedule} may skip a fold that cannot have
   * anything to fold without touching Redis or the row. Absent reads as 0.
   */
  readonly foldedAtLeast?: number;
}

/** What one fold will send: the lines past the stored count, oldest first, and the count after. */
export interface FreeChatFoldPlan {
  /** This session's lines the stored summary already covers. */
  readonly watermark: number;
  /** The aged-out foldable lines to fold now — at most {@link FREE_CHAT_FOLD_MAX_LINES}. */
  readonly batch: readonly BufferedMessage[];
  /** `watermark + batch.length` — the stored `folded_lines` if this fold lands. */
  readonly target: number;
}

/**
 * THE FOLDABLE LINES THAT HAVE AGED OUT of the reply's recent-turn window (R21), oldest first.
 *
 * FOLDABLE means a free-mode casual or career exchange — the worker's message and the model's
 * reply (`BufferedMessage.foldable`, R22); nothing else in the session ever is. AGED OUT means no
 * longer among the newest {@link REPLY_TURNS} lines the reply call would send
 * (`recentTurnOf` — the SAME predicate, so the window here cannot drift from the one the model
 * sees). Every line counts toward that window, fixed lines included, because they occupy it.
 *
 * Index-stable within a session: free mode precedes résumé mode and the buffer is append-only, so
 * the n-th foldable line stays the n-th — which is what lets a stored count mark the fold's place.
 */
export function agedOutFoldable(messages: readonly BufferedMessage[]): BufferedMessage[] {
  const windowed = new Set<BufferedMessage>();
  for (let i = messages.length - 1; i >= 0 && windowed.size < REPLY_TURNS; i--) {
    const message = messages[i]!;
    if (recentTurnOf(message, null) !== null) windowed.add(message);
  }
  return messages.filter((message) => message.foldable === true && !windowed.has(message));
}

/**
 * WHEN TO FOLD (R21): only once at least {@link FREE_CHAT_FOLD_MIN_LINES} aged-out foldable lines
 * lie past the stored count, and then the OLDEST of them, at most
 * {@link FREE_CHAT_FOLD_MAX_LINES} — the remainder folds next time, so the count stays a
 * contiguous mark. Null when there is nothing to fold yet.
 */
export function planFold(
  messages: readonly BufferedMessage[],
  watermark: number,
): FreeChatFoldPlan | null {
  const pending = agedOutFoldable(messages).slice(watermark);
  if (pending.length < FREE_CHAT_FOLD_MIN_LINES) return null;
  const batch = pending.slice(0, FREE_CHAT_FOLD_MAX_LINES);
  return { watermark, batch, target: watermark + batch.length };
}

/** Every fixed free-chat line — the casual NUDGE rides inside a model reply's bubble. */
const FIXED_LINES: ReadonlySet<string> = new Set(
  FREE_CHAT_COPY_ENTRIES.map(([, line]) => line.latin),
);

/**
 * The batch as the contract's turns: each line through `recentTurnOf` (the worker's known name
 * redacted, `{{token}}`s stripped, clipped), with any FIXED line removed from a reply bubble first —
 * the every-third casual nudge is appended to the model's lines, and reviewed copy is not
 * conversation. A line left blank is dropped.
 *
 * A LINE CARRYING A HARD IDENTIFIER IS DROPPED TOO (G1 — `containsHardIdentifier`, and a scanner
 * that throws counts as a hit): it is never sent, so the model cannot echo it into notes that
 * would then be refused for it on every retry. Its place still counts toward the fold's target.
 */
export function summaryTurnsOf(
  batch: readonly BufferedMessage[],
  knownName: string | null,
): CompanionRecentTurn[] {
  const turns: CompanionRecentTurn[] = [];
  for (const message of batch) {
    const text =
      message.role === "assistant"
        ? message.text
            .split("\n")
            .filter((line) => !FIXED_LINES.has(line.trim()))
            .join("\n")
        : message.text;
    const turn = recentTurnOf({ ...message, text }, knownName);
    if (turn !== null && !carriesHardIdentifier(turn.text)) turns.push(turn);
  }
  return turns;
}

/**
 * Did a REAL, successful call answer — `ai_metadata.real_call === true` and `success !== false`?
 * The classifier's real-verdict rule (ADR-0051 §3.2). Only such an answer is judged: a mock, a
 * failed call, no metadata or no output at all is a TRANSPORT failure, which consumes nothing.
 */
function realCallOf(out: FreeChatSummarizeOutput | null): out is FreeChatSummarizeOutput {
  const meta = out?.ai_metadata ?? null;
  return meta !== null && meta.real_call === true && meta.success !== false;
}

/**
 * THE ROLLING CONVERSATION SUMMARY'S SIDE EFFECTS (ADR-0051 §8, Release 2) — the fold.
 *
 * WHEN. The orchestrator {@link schedule}s a fold after a free-mode casual or career reply was
 * SERVED and its CAS won; nothing else triggers one. The worker's response NEVER waits on it:
 * `schedule` returns at once and the fold runs on its own, its every failure swallowed and logged
 * with ids and closed reasons only.
 *
 * WHAT. Under the session's lock ({@link FreeChatFoldLock}, at most one fold in flight), read the
 * stored summary off the CURRENT row (or, when it carries no text yet, the worker's latest), plan
 * the fold ({@link planFold}), send `previous_summary` + the aged-out turns to the summarizer,
 * screen what comes back (`screenFreeChatSummary`) and merge it monotonically onto the row.
 *
 * NEVER THE SAME BATCH FOREVER. A REAL call that answered null, or whose notes were refused, has
 * judged these lines: the batch is CONSUMED — the count advances to the plan's target and the
 * previous text is kept (a watermark-only record, `text: null`, when there is none). Only a
 * transport failure (a mock, a failed call, no metadata, a merge that did not write) leaves the
 * count where it was, so the next fold retries the same lines.
 *
 * RECORDED. The spend (`profiling_free_summary`) once per call, and `chat.free_chat_summary_updated`
 * after every fold that reached the model — ids, a closed outcome and counts, never the text.
 *
 * PRIVACY (ADR-0047). The worker's own name is redacted out of every turn and the previous summary
 * before the call, and out of the output before it is stored (G2); output carrying a hard
 * identifier is refused (G1). The kill switch stops folding at the caller: no fold is scheduled
 * while `CHAT_FREE_CHAT_DISABLED` is on.
 */
@Injectable()
export class FreeChatSummaryService {
  private readonly logger = new Logger(FreeChatSummaryService.name);
  /** Folds running now — only so a test (or a drain) can wait for them. Never read on a turn. */
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly ai: AiService,
    private readonly cost: AiCostRecorder,
    private readonly events: EventsService,
    private readonly chat: ChatRepository,
    private readonly lock: FreeChatFoldLock,
  ) {}

  /**
   * Fold in the background, OFF THE REQUEST PATH — returns immediately. A transcript with nothing to
   * fold past the count the request's own row read already saw (`foldedAtLeast`, a lower bound)
   * costs nothing: no Redis, no row read.
   */
  schedule(job: FreeChatFoldJob): void {
    if (planFold(job.messages, job.foldedAtLeast ?? 0) === null) return;
    const run = this.fold(job).catch((error: unknown) => {
      this.logger.error(
        `free-chat fold crashed session=${job.sessionId}: ` +
          `${logSafeReason(error, "free-chat fold")}`,
      );
    });
    this.inflight.add(run);
    void run.finally(() => this.inflight.delete(run));
  }

  /** Resolves once every fold scheduled so far has finished. Tests and drains only. */
  async idle(): Promise<void> {
    await Promise.all([...this.inflight]);
  }

  /** One fold, under the session's lock. Never throws. */
  async fold(job: FreeChatFoldJob): Promise<void> {
    const token = await this.lock.acquire(job.sessionId);
    if (token === null) {
      this.logger.log(`free-chat fold skipped session=${job.sessionId}: another fold holds it`);
      return;
    }
    try {
      await this.foldLocked(job);
    } catch (error) {
      this.logger.warn(
        `free-chat fold failed session=${job.sessionId}; the previous summary is kept: ` +
          `${logSafeReason(error, "free-chat fold")}`,
      );
    } finally {
      await this.lock.release(job.sessionId, token);
    }
  }

  private async foldLocked(job: FreeChatFoldJob): Promise<void> {
    const current = await this.currentSummary(job);
    if (current === "foreign") return;
    const plan = planFold(job.messages, foldWatermarkOf(current.own, job.sessionId));
    if (plan === null) return;

    // FAIL CLOSED: without the worker's name nothing can be redacted (G2), so nothing is sent. The
    // count does not move; the next fold retries.
    const lookup = await this.knownNameOf(job);
    if (!lookup.ok) return;
    const name = lookup.name;
    const turns = summaryTurnsOf(plan.batch, name);
    if (turns.length === 0) return;
    const input = FreeChatSummarizeInputSchema.safeParse({
      previous_summary: summaryForModel(current.previousText, name),
      turns,
    });
    if (!input.success) {
      this.logger.warn(
        `free-chat summarize input off-contract session=${job.sessionId} ` +
          `paths=[${input.error.issues.map((i) => i.path.join(".")).join(",")}]; no fold`,
      );
      return;
    }

    const out = await this.ai.freeChatSummarize(input.data, {
      correlationId: job.correlationId,
      requestId: job.requestId,
    });
    await this.cost.record(
      out?.ai_metadata ?? null,
      "profiling_free_summary",
      null,
      job.correlationId,
      job.requestId,
      { workerId: job.workerId, sessionId: job.sessionId },
    );

    if (!realCallOf(out)) {
      // A TRANSPORT failure: nothing judged these lines, so the count stays and they retry.
      await this.recordFold(job, "unavailable", plan.target, null);
      return;
    }
    if (out.summary === null) {
      // A real call found nothing worth keeping: the batch is consumed, the previous text kept.
      await this.store(job, current.previousText, plan.target);
      await this.recordFold(job, "unavailable", plan.target, null);
      return;
    }
    const screened = screenFreeChatSummary(out.summary, name);
    if (screened.kind === "reject") {
      // The CLOSED reason only — never a word of the summary, which is model text.
      this.logger.warn(
        `free-chat summary rejected session=${job.sessionId} (${screened.reason}); ` +
          `the previous summary is kept and the batch consumed`,
      );
      await this.store(job, current.previousText, plan.target);
      await this.recordFold(job, "rejected", plan.target, null);
      return;
    }
    const wrote = await this.store(job, screened.text, plan.target);
    await this.recordFold(
      job,
      wrote ? "updated" : "unavailable",
      plan.target,
      wrote ? screened.text.length : null,
    );
  }

  /**
   * The summary this fold builds on: the CURRENT row's own record (`own` — whose count is the fold's
   * place) and the text to extend (`previousText` — the row's, else the worker's latest text from an
   * earlier session, R23; a watermark-only record has none). `"foreign"` when the row does not
   * belong to the job's worker: a tripwire, never expected, and nothing is folded.
   */
  private async currentSummary(
    job: FreeChatFoldJob,
  ): Promise<
    { readonly own: FreeChatSummary | null; readonly previousText: string | null } | "foreign"
  > {
    const row = await this.chat.findSession(job.sessionId);
    if (!row || row.workerId !== job.workerId) {
      this.logger.error(
        `free-chat fold session=${job.sessionId} does not belong to worker=${job.workerId}; ` +
          `nothing is folded`,
      );
      return "foreign";
    }
    const own = readFreeChatSummary(row.conversationState);
    const ownText = summaryTextOf(own);
    if (ownText !== null) return { own, previousText: ownText };
    const latest = await this.chat.findLatestFreeChatSummary(job.workerId);
    return { own, previousText: summaryTextOf(readFreeChatSummaryValue(latest?.summary)) };
  }

  /**
   * The monotonic merge onto the current row — a new summary, or (`text` null or the previous text)
   * a consumed batch. False when it did not write (or threw).
   */
  private async store(job: FreeChatFoldJob, text: string | null, target: number): Promise<boolean> {
    try {
      const wrote = await this.chat.mergeFreeChatSummary(job.sessionId, job.workerId, {
        v: 1,
        text,
        updated_at: new Date().toISOString(),
        session_id: job.sessionId,
        folded_lines: target,
      });
      if (!wrote) {
        this.logger.log(
          `free-chat summary not stored session=${job.sessionId} folded=${target}: ` +
            `a fold covering as many lines already landed`,
        );
      }
      return wrote;
    } catch (error) {
      this.logger.warn(
        `free-chat summary not stored session=${job.sessionId}; the previous summary is kept: ` +
          `${logSafeReason(error, "free-chat summary merge")}`,
      );
      return false;
    }
  }

  /**
   * `chat.free_chat_summary_updated` — once per fold that reached the model. `updated` iff a summary
   * was STORED; anything else kept the previous one.
   *
   * KEYED `<session>:<folded_lines>` for an update — the count only grows, so a stored update is
   * unique per key. A refusal or an unavailable fold appends its outcome: a fold capped at the
   * 24-line batch retries the SAME count after a failure, and the update that finally lands must
   * not be swallowed as a duplicate of the failure before it. Never throws.
   */
  private async recordFold(
    job: FreeChatFoldJob,
    outcome: FreeChatSummaryOutcome,
    foldedLines: number,
    summaryChars: number | null,
  ): Promise<void> {
    const base = `chat.free_chat_summary_updated:${job.sessionId}:${foldedLines}`;
    try {
      await this.events.emit({
        event_name: "chat.free_chat_summary_updated",
        actor: { actor_type: "system" },
        subject: { subject_type: "chat_session", subject_id: job.sessionId },
        payload: {
          worker_id: job.workerId,
          session_id: job.sessionId,
          outcome,
          folded_lines: foldedLines,
          summary_chars: summaryChars,
        },
        idempotencyKey: outcome === "updated" ? base : `${base}:${outcome}`,
        correlationId: job.correlationId,
        requestId: job.requestId,
      });
    } catch (error) {
      this.logger.error(
        `chat.free_chat_summary_updated not recorded session=${job.sessionId} ` +
          `outcome=${outcome}: ${logSafeReason(error, "free-chat summary event")}`,
      );
    }
  }

  /**
   * The worker's own name for the G2 redaction — `ok: false` when the lookup FAILED (and the caller
   * folds nothing), as opposed to a worker with no name stored (`name: null`, nothing to redact).
   * Logged with ids only.
   */
  private async knownNameOf(
    job: FreeChatFoldJob,
  ): Promise<{ readonly ok: true; readonly name: string | null } | { readonly ok: false }> {
    try {
      return { ok: true, name: await job.knownName() };
    } catch {
      this.logger.warn(
        `known name unavailable worker=${job.workerId} session=${job.sessionId}; ` +
          `no fold now, the next one retries`,
      );
      return { ok: false };
    }
  }
}
