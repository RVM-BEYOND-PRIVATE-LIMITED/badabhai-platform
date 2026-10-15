import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import type { NewCompanionMessage } from "@badabhai/db";
import { logSafeReason, sqlStateOf } from "../common/db-error";
import { NewsLinksWireSchema } from "../chat/chat.dto";
import {
  COMPANION_HISTORY_MAX,
  CompanionHistoryItemSchema,
  type CompanionHistoryItem,
  type CompanionTurn,
} from "./chat-companion.dto";
import {
  CompanionHistoryRepository,
  type CompanionHistoryRow,
  type CompanionModelLine,
  type CompanionSummaryRecord,
} from "./companion-history.repository";

/** #2297 (ADR-0056) — the stored conversation's window: the last 7 days. */
export const COMPANION_HISTORY_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

/** Postgres `undefined_table` — migration 0135 not applied yet. */
const PG_UNDEFINED_TABLE = "42P01";

/** The start of the window that ends at `at`. */
export function historyWindowStart(at: Date): Date {
  return new Date(at.getTime() - COMPANION_HISTORY_WINDOW_DAYS * DAY_MS);
}

/** What one served message turn stores. */
export interface KeptTurn {
  readonly workerId: string;
  /** The worker's message as sent — the chip label for a tap. */
  readonly workerText: string;
  readonly submissionId: string | null;
  /** The turn the worker was served, exactly as the app renders it. */
  readonly turn: CompanionTurn;
  /** Whether a later model call may read this turn (ADR-0055 F3/F4: never distress or trash). */
  readonly modelContext: boolean;
  readonly at: Date;
}

/** A read that may have failed: `ok: false` means "unknown", never "empty". */
export type HistoryRead<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/** What one retention tick did — counts only. */
export interface CompanionHistorySweepResult {
  readonly linesDeleted: number;
  readonly summariesDeleted: number;
  /** True when migration 0135 is not applied: nothing to sweep. */
  readonly tablesMissing: boolean;
}

/** Per-tick cap on deleted lines; the next tick drains a backlog. */
const SWEEP_BATCH_LIMIT = 5_000;
/** At most this many batches per tick. */
const SWEEP_MAX_BATCHES = 20;

/** The stored chips — the turn's own option shape, validated on the way out. */
const StoredOptionsSchema = z
  .array(
    z
      .object({
        option_key: z.string(),
        label_text: z.string(),
        is_none_of_above: z.boolean(),
      })
      .strict(),
  )
  .min(1);
const StoredFollowupsSchema = z.array(z.string()).min(1);

/**
 * Has this process already said that migration 0135 is missing? One warn line per process, not one
 * per request: until the owner applies the migration every companion request would otherwise log.
 */
let missingTablesWarned = false;

/**
 * THE BADA BHAI CHAT'S STORED CONVERSATION (#2297, owner rulings 2026-10-15, ADR-0056) — what is
 * stored, what is read back, and what happens when the store is not there. No model, no AI client.
 *
 * WHAT IS STORED. After every served message turn, the worker's message (as sent) and the reply
 * exactly as the app renders it; and the recap bubble served on an open that finds NO line in the
 * window, so it heads the conversation. A reopen within 7 days then draws only the stored lines.
 *
 * NEVER BLOCKS, NEVER FAILS A TURN. Every write runs in the background after the turn is computed,
 * its failure logged with ids and a closed reason only (`logSafeReason` — a query error's bound
 * parameters are the worker's words). Every read fails soft to "no history".
 *
 * DEPLOY-SAFE WITHOUT A FLAG. Until migration 0135 is applied every statement fails with
 * `undefined_table` (42P01): the chat then stores nothing, returns no history, reads no summary —
 * exactly today's chat — and the process says so ONCE.
 *
 * REPLAY-SAFE. A resent submission writes nothing (the partial unique index on worker, submission
 * and role, `ON CONFLICT DO NOTHING`).
 */
@Injectable()
export class CompanionHistoryService {
  private readonly logger = new Logger(CompanionHistoryService.name);
  /** Background writes in flight — only so a test (or a drain) can wait for them. */
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly repo: CompanionHistoryRepository) {}

  /** Resolves once every background write scheduled so far has finished. Tests and drains only. */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight]);
  }

  // ── reads ──────────────────────────────────────────────────────────────────────────────────

  /**
   * The conversation of the last 7 days as `GET /chat/companion` returns it: oldest first, at most
   * {@link COMPANION_HISTORY_MAX} lines (the newest). A stored line that no longer fits the wire
   * contract is dropped on its own; the rest are kept. `ok: false` when the read failed.
   */
  async window(workerId: string, now: Date): Promise<HistoryRead<CompanionHistoryItem[]>> {
    const rows = await this.soft("history read", workerId, () =>
      this.repo.listSince(workerId, historyWindowStart(now), COMPANION_HISTORY_MAX),
    );
    if (!rows.ok) return rows;
    const items: CompanionHistoryItem[] = [];
    for (const row of rows.value) {
      const item = CompanionHistoryItemSchema.safeParse(toWire(row));
      if (item.success) items.push(item.data);
    }
    if (items.length < rows.value.length) {
      this.logger.warn(
        `companion history for worker ${workerId}: ${rows.value.length - items.length} stored ` +
          `line(s) off the wire contract were left out`,
      );
    }
    return { ok: true, value: items };
  }

  /** The newest `limit` lines a model call may read, within the window ending at `at`. */
  async modelLines(
    workerId: string,
    at: Date,
    limit: number,
  ): Promise<HistoryRead<CompanionModelLine[]>> {
    return this.soft("model lines read", workerId, () =>
      this.repo.listModelLinesSince(workerId, historyWindowStart(at), limit),
    );
  }

  /**
   * The worker's summary record while its conversation is alive — some stored line in the 7 days
   * before `at` — else `value: undefined` (none, or expired).
   */
  async liveSummary(
    workerId: string,
    at: Date,
  ): Promise<HistoryRead<CompanionSummaryRecord | undefined>> {
    return this.soft("summary read", workerId, () =>
      this.repo.findLiveSummary(workerId, historyWindowStart(at), at),
    );
  }

  // ── writes ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Store one served turn — the worker's line, then the reply one millisecond later so the pair
   * always reads back in order — IN THE BACKGROUND. `afterStored` runs once the lines are written
   * (the summary fold); never when the write failed or wrote nothing (a replay).
   */
  keepTurn(kept: KeptTurn, afterStored?: () => Promise<void>): void {
    const lines: NewCompanionMessage[] = [];
    const workerText = kept.workerText.trim();
    if (workerText.length > 0) {
      lines.push({
        workerId: kept.workerId,
        role: "worker",
        bodyText: workerText,
        submissionId: kept.submissionId,
        modelContext: kept.modelContext,
        createdAt: kept.at,
      });
    }
    const reply = replyLineOf(kept.workerId, kept.turn, new Date(kept.at.getTime() + 1));
    if (reply !== null) {
      lines.push({ ...reply, submissionId: kept.submissionId, modelContext: kept.modelContext });
    }
    this.background(kept.workerId, async () => {
      const written = await this.soft("turn write", kept.workerId, () => this.repo.append(lines));
      if (written.ok && written.value > 0 && afterStored !== undefined) await afterStored();
    });
  }

  /**
   * Store the recap bubble served on an open — only while the worker has NO line in the window, so
   * it heads a new conversation and is never stored twice. In the background.
   */
  keepRecap(workerId: string, turn: CompanionTurn, now: Date): void {
    const line = replyLineOf(workerId, turn, now);
    if (line === null) return;
    this.background(workerId, async () => {
      await this.soft("recap write", workerId, () =>
        this.repo.appendIfNoneSince(line, historyWindowStart(now)),
      );
    });
  }

  /** Store the worker's summary record (monotonic; see the repository). False when it did not. */
  async storeSummary(
    workerId: string,
    record: CompanionSummaryRecord,
    replaceExpired: boolean,
  ): Promise<boolean> {
    const stored = await this.soft("summary write", workerId, () =>
      this.repo.upsertSummary(workerId, record, replaceExpired),
    );
    return stored.ok && stored.value;
  }

  // ── retention ──────────────────────────────────────────────────────────────────────────────

  /**
   * THE DAILY RETENTION TICK: delete every line older than 7 days (in bounded batches), then every
   * summary whose worker has no line left in the window. A missing table is "nothing to sweep".
   */
  async sweep(now: Date): Promise<CompanionHistorySweepResult> {
    const cutoff = historyWindowStart(now);
    let linesDeleted = 0;
    try {
      for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
        const deleted = await this.repo.deleteLinesBefore(cutoff, SWEEP_BATCH_LIMIT);
        linesDeleted += deleted;
        if (deleted < SWEEP_BATCH_LIMIT) break;
      }
      const summariesDeleted = await this.repo.deleteSummariesWithoutLinesSince(cutoff);
      return { linesDeleted, summariesDeleted, tablesMissing: false };
    } catch (error) {
      if (sqlStateOf(error) === PG_UNDEFINED_TABLE) {
        this.warnTablesMissing();
        return { linesDeleted, summariesDeleted: 0, tablesMissing: true };
      }
      throw error;
    }
  }

  // ── plumbing ───────────────────────────────────────────────────────────────────────────────

  /**
   * Run one statement FAIL-SOFT: its value, or `ok: false` on any error — a missing table (warned
   * once per process) or anything else (warned with a closed reason, never a bound parameter).
   */
  private async soft<T>(
    operation: string,
    workerId: string,
    run: () => Promise<T>,
  ): Promise<HistoryRead<T>> {
    try {
      return { ok: true, value: await run() };
    } catch (error) {
      if (sqlStateOf(error) === PG_UNDEFINED_TABLE) {
        this.warnTablesMissing();
      } else {
        this.logger.warn(
          `companion ${operation} failed for worker ${workerId}; the chat goes on without it: ` +
            `${logSafeReason(error, `companion ${operation}`)}`,
        );
      }
      return { ok: false };
    }
  }

  private warnTablesMissing(): void {
    if (missingTablesWarned) return;
    missingTablesWarned = true;
    this.logger.warn(
      "companion history tables are missing (migration 0135 not applied): the Bada Bhai chat " +
        "stores no history and reads no summary until it is — said once per process",
    );
  }

  /** Run `work` off the request path, tracked for {@link idle}; nothing it throws escapes. */
  private background(workerId: string, work: () => Promise<void>): void {
    const run = work().catch((error: unknown) => {
      this.logger.error(
        `companion history background work crashed for worker ${workerId}: ` +
          `${logSafeReason(error, "companion history")}`,
      );
    });
    this.inflight.add(run);
    void run.finally(() => this.inflight.delete(run));
  }
}

/** Test seam: forget that the missing-table warning was given. */
export function resetMissingTablesWarningForTests(): void {
  missingTablesWarned = false;
}

/**
 * A served turn as the stored `bada_bhai` line, or null when it carries no text. Everything the
 * app draws: the text, the read-aloud twin, the "never read aloud" marker, the chips and tiles.
 */
function replyLineOf(workerId: string, turn: CompanionTurn, at: Date): NewCompanionMessage | null {
  const text = turn.reply.trim();
  if (text.length === 0) return null;
  return {
    workerId,
    role: "bada_bhai",
    bodyText: turn.reply,
    ttsText: turn.tts_text ?? null,
    readAloud: turn.read_aloud === false ? false : null,
    suggestedOptions: turn.suggested_options.length > 0 ? turn.suggested_options : null,
    suggestedFollowups: turn.suggested_followups.length > 0 ? turn.suggested_followups : null,
    newsLinks: turn.news_links !== undefined && turn.news_links.length > 0 ? turn.news_links : null,
    createdAt: at,
  };
}

/** One stored line as the wire carries it: every absent value OMITTED, never null. */
function toWire(row: CompanionHistoryRow): Record<string, unknown> {
  const options = StoredOptionsSchema.safeParse(row.suggestedOptions);
  const followups = StoredFollowupsSchema.safeParse(row.suggestedFollowups);
  const news = NewsLinksWireSchema.safeParse(row.newsLinks);
  return {
    id: row.id,
    role: row.role,
    text: row.bodyText,
    ...(row.ttsText ? { tts_text: row.ttsText } : {}),
    ...(row.readAloud === false ? { read_aloud: false } : {}),
    ...(options.success ? { suggested_options: options.data } : {}),
    ...(followups.success ? { suggested_followups: followups.data } : {}),
    ...(news.success ? { news_links: news.data } : {}),
    created_at: row.createdAt.toISOString(),
  };
}
