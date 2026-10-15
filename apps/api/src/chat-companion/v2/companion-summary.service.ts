import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import {
  FreeChatSummarizeInputSchema,
  type CompanionRecentTurn,
  type FreeChatSummarizeOutput,
} from "@badabhai/ai-contracts";
import type { FreeChatSummaryOutcome } from "@badabhai/types";
import { SERVER_CONFIG } from "../../config/config.module";
import { AiCostRecorder } from "../../ai/ai-cost-recorder.service";
import { AiService } from "../../ai/ai.service";
import { logSafeReason } from "../../common/db-error";
import { EventsService } from "../../events/events.service";
import { FreeChatFoldLock } from "../../profiling/free-chat/free-chat-fold.lock";
import {
  REPLY_TURNS,
  recentTurnOf,
  summaryForModel,
} from "../../profiling/free-chat/free-chat-model-calls";
import {
  FREE_CHAT_FOLD_MAX_LINES,
  FREE_CHAT_FOLD_MIN_LINES,
  carriesHardIdentifier,
  screenFreeChatSummary,
} from "../../profiling/free-chat/free-chat-summary";
import { FreeChatSummaryReader } from "../../profiling/free-chat/free-chat-summary.reader";
import { WorkerNameReader } from "../../workers/worker-name-sources";
import { companionBrainOn } from "../companion-brain-switch";
import { CompanionHistoryService } from "../companion-history.service";
import type { CompanionModelLine } from "../companion-history.repository";
import { COMPANION_HISTORY_MAX } from "../chat-companion.dto";

/** One fold's inputs: ids, the request's correlation, and when the turn that triggered it ran. */
export interface CompanionFoldJob {
  readonly workerId: string;
  readonly correlationId: string;
  readonly requestId: string;
  /** The turn's own time — the window and the summary's liveness are judged as of this instant. */
  readonly at: Date;
}

/** What one fold will send: the aged-out lines past the watermark, and the watermark after. */
export interface CompanionFoldPlan {
  readonly batch: readonly CompanionModelLine[];
  /** The `created_at` of the batch's newest line — the stored `folded_through` if the fold lands. */
  readonly foldedThrough: Date;
}

/**
 * WHEN TO FOLD (the ADR-0051 R21 rule on the stored conversation). `lines` are the window's
 * model-context lines, oldest first. The newest {@link REPLY_TURNS} are the reply's own window and
 * are never folded; of the rest, only those after the watermark are pending. Fold once at least
 * {@link FREE_CHAT_FOLD_MIN_LINES} are pending, the OLDEST of them, at most
 * {@link FREE_CHAT_FOLD_MAX_LINES} — the remainder folds next time. Null when there is nothing to
 * fold yet.
 */
export function planCompanionFold(
  lines: readonly CompanionModelLine[],
  watermark: Date | null,
): CompanionFoldPlan | null {
  const agedOut = lines.slice(0, Math.max(0, lines.length - REPLY_TURNS));
  const pending =
    watermark === null
      ? agedOut
      : agedOut.filter((line) => line.createdAt.getTime() > watermark.getTime());
  if (pending.length < FREE_CHAT_FOLD_MIN_LINES) return null;
  const batch = pending.slice(0, FREE_CHAT_FOLD_MAX_LINES);
  return { batch, foldedThrough: batch[batch.length - 1]!.createdAt };
}

/**
 * The batch as the contract's turns: each line through `recentTurnOf` (the worker's known name
 * redacted, `{{token}}`s stripped, clipped). A line carrying a hard identifier is DROPPED (G1 —
 * a scanner that throws counts as a hit), so the model cannot echo it into notes that would then be
 * refused for it on every retry; its place still counts toward the watermark. A blank line is
 * dropped too.
 */
export function companionSummaryTurnsOf(
  batch: readonly CompanionModelLine[],
  knownName: string | null,
): CompanionRecentTurn[] {
  const turns: CompanionRecentTurn[] = [];
  for (const line of batch) {
    const role = line.role === "worker" ? "worker" : "assistant";
    const turn = recentTurnOf({ role, text: line.text }, knownName);
    if (turn !== null && !carriesHardIdentifier(turn.text)) turns.push(turn);
  }
  return turns;
}

/** Did a REAL, successful call answer? Only such an answer judges a batch (ADR-0051 §3.2). */
function realCallOf(out: FreeChatSummarizeOutput | null): out is FreeChatSummarizeOutput {
  const meta = out?.ai_metadata ?? null;
  return meta !== null && meta.real_call === true && meta.success !== false;
}

/**
 * THE BADA BHAI CHAT'S ROLLING SUMMARY (#2297, owner ruling 2026-10-15, ADR-0056) — the AI's
 * memory of the WHOLE conversation, carried for 7 days. The ADR-0051 §8 machinery, on the stored
 * conversation instead of a profiling session: the same armed `profiling_free_summary` task, the
 * same contract, the same API validation of what comes back.
 *
 * READ — {@link latestText}, by the brain's casual/career REPLY with every query (never by the
 * classifier, ADR-0051 R24): this summary while it is live (the newest line it covers is in
 * the last 7 days), else the profiling chat's summary (#2284 R4). Every failure reads as "none".
 *
 * FOLD — {@link schedule}d after a served turn's lines are stored, on the brain only. Off the
 * request path; under the worker's lock (`FreeChatFoldLock`, at most one fold in flight per worker);
 * every failure swallowed and logged with ids and closed reasons only. The model-context lines that
 * aged out of the reply's six-turn window and lie past the watermark are sent with the previous
 * summary; the answer is screened (`screenFreeChatSummary`: identifiers, template tokens, the
 * note format, abuse, injection, the worker's own name, the length) and stored monotonically.
 * NEVER THE SAME BATCH FOREVER: a real call that answered nothing usable consumes the batch (the
 * watermark moves, the previous text is kept); only a transport failure leaves it to retry.
 *
 * RECORDED: the spend once per call (`profiling_free_summary`), and `chat.companion_summary_updated`
 * after every fold that reached the model — ids, a closed outcome and counts, never the text.
 *
 * THE KILL SWITCH stops both halves: no fold is scheduled and the reply is today's v2 path.
 */
@Injectable()
export class CompanionSummaryService {
  private readonly logger = new Logger(CompanionSummaryService.name);
  /** Folds running now — only so a test (or a drain) can wait for them. */
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly history: CompanionHistoryService,
    private readonly profiling: FreeChatSummaryReader,
    private readonly ai: AiService,
    private readonly cost: AiCostRecorder,
    private readonly events: EventsService,
    private readonly lock: FreeChatFoldLock,
    private readonly names: WorkerNameReader,
  ) {}

  // ── read ───────────────────────────────────────────────────────────────────────────────────

  /**
   * The summary the brain's reply carries: the companion's own while it is live (its newest line is
   * still in the window — a fresh line never revives an expired one),
   * else the profiling chat's (#2284 R4). Null when there is neither. Never throws.
   */
  async latestText(workerId: string): Promise<string | null> {
    const own = await this.history.liveSummary(workerId, new Date());
    const text = own.ok ? (own.value?.summary ?? null) : null;
    return text ?? this.profiling.latestText(workerId);
  }

  // ── fold ───────────────────────────────────────────────────────────────────────────────────

  /** Fold in the background — returns at once. Only while the brain is on. */
  schedule(job: CompanionFoldJob): void {
    if (!companionBrainOn(this.config)) return;
    const run = this.fold(job).catch((error: unknown) => {
      this.logger.error(
        `companion fold crashed worker=${job.workerId}: ${logSafeReason(error, "companion fold")}`,
      );
    });
    this.inflight.add(run);
    void run.finally(() => this.inflight.delete(run));
  }

  /** Resolves once every fold scheduled so far has finished. Tests and drains only. */
  async idle(): Promise<void> {
    await Promise.all([...this.inflight]);
  }

  /** One fold, under the worker's lock. Never throws. */
  async fold(job: CompanionFoldJob): Promise<void> {
    const token = await this.lock.acquireCompanion(job.workerId);
    if (token === null) {
      this.logger.log(`companion fold skipped worker=${job.workerId}: another fold holds it`);
      return;
    }
    try {
      await this.foldLocked(job);
    } catch (error) {
      this.logger.warn(
        `companion fold failed worker=${job.workerId}; the previous summary is kept: ` +
          `${logSafeReason(error, "companion fold")}`,
      );
    } finally {
      await this.lock.releaseCompanion(job.workerId, token);
    }
  }

  private async foldLocked(job: CompanionFoldJob): Promise<void> {
    // Both reads fail soft: an unknown summary or an unreadable window folds nothing now.
    const current = await this.history.liveSummary(job.workerId, job.at);
    if (!current.ok) return;
    const lines = await this.history.modelLines(job.workerId, job.at, COMPANION_HISTORY_MAX);
    if (!lines.ok) return;
    const live = current.value;
    const plan = planCompanionFold(lines.value, live?.foldedThrough ?? null);
    if (plan === null) return;

    // FAIL CLOSED: without the worker's name nothing can be redacted (G2), so nothing is sent.
    let name: string | null;
    try {
      name = await this.names.sourcesFor(job.workerId).knownName();
    } catch {
      this.logger.warn(
        `known name unavailable worker=${job.workerId}; no companion fold now, the next one retries`,
      );
      return;
    }
    const turns = companionSummaryTurnsOf(plan.batch, name);
    if (turns.length === 0) return;
    const previousText = live?.summary ?? null;
    const input = FreeChatSummarizeInputSchema.safeParse({
      previous_summary: summaryForModel(previousText, name),
      turns,
    });
    if (!input.success) {
      this.logger.warn(
        `companion summarize input off-contract worker=${job.workerId} ` +
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
      { workerId: job.workerId, sessionId: null },
    );

    const folded = plan.batch.length;
    // A record found expired (or absent) is replaced whatever its watermark says.
    const replaceExpired = live === undefined;
    if (!realCallOf(out)) {
      // A TRANSPORT failure: nothing judged these lines, so the watermark stays and they retry.
      await this.recordFold(job, "unavailable", folded, null, plan.foldedThrough);
      return;
    }
    if (out.summary === null) {
      // A real call found nothing worth keeping: the batch is consumed, the previous text kept.
      await this.store(job, previousText, plan.foldedThrough, replaceExpired);
      await this.recordFold(job, "unavailable", folded, null, plan.foldedThrough);
      return;
    }
    const screened = screenFreeChatSummary(out.summary, name);
    if (screened.kind === "reject") {
      // The CLOSED reason only — never a word of the summary, which is model text.
      this.logger.warn(
        `companion summary rejected worker=${job.workerId} (${screened.reason}); ` +
          `the previous summary is kept and the batch consumed`,
      );
      await this.store(job, previousText, plan.foldedThrough, replaceExpired);
      await this.recordFold(job, "rejected", folded, null, plan.foldedThrough);
      return;
    }
    const wrote = await this.store(job, screened.text, plan.foldedThrough, replaceExpired);
    await this.recordFold(
      job,
      wrote ? "updated" : "unavailable",
      folded,
      wrote ? screened.text.length : null,
      plan.foldedThrough,
    );
  }

  private async store(
    job: CompanionFoldJob,
    summary: string | null,
    foldedThrough: Date,
    replaceExpired: boolean,
  ): Promise<boolean> {
    const wrote = await this.history.storeSummary(
      job.workerId,
      { summary, foldedThrough },
      replaceExpired,
    );
    if (!wrote) {
      this.logger.log(
        `companion summary not stored worker=${job.workerId}: a fold covering as much already ` +
          `landed, or the write failed`,
      );
    }
    return wrote;
  }

  /**
   * `chat.companion_summary_updated` — once per fold that reached the model. `updated` iff a
   * summary was STORED. Keyed `<worker>:<folded_through>` for an update (the watermark only moves
   * forward, so a stored update is unique per key); a refusal or an unavailable fold appends its
   * outcome, so the update that finally lands after a failure is not swallowed as its duplicate.
   * Never throws.
   */
  private async recordFold(
    job: CompanionFoldJob,
    outcome: FreeChatSummaryOutcome,
    foldedMessages: number,
    summaryChars: number | null,
    foldedThrough: Date,
  ): Promise<void> {
    const base = `chat.companion_summary_updated:${job.workerId}:${foldedThrough.toISOString()}`;
    try {
      await this.events.emit({
        event_name: "chat.companion_summary_updated",
        actor: { actor_type: "system" },
        subject: { subject_type: "worker", subject_id: job.workerId },
        payload: {
          worker_id: job.workerId,
          outcome,
          folded_messages: foldedMessages,
          summary_chars: summaryChars,
        },
        idempotencyKey: outcome === "updated" ? base : `${base}:${outcome}`,
        correlationId: job.correlationId,
        requestId: job.requestId,
      });
    } catch (error) {
      this.logger.error(
        `chat.companion_summary_updated not recorded worker=${job.workerId} ` +
          `outcome=${outcome}: ${logSafeReason(error, "companion summary event")}`,
      );
    }
  }
}
