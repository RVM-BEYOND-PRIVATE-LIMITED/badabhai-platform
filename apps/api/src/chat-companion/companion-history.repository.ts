import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, inArray, lt, lte, sql } from "drizzle-orm";
import {
  companionConversationSummaries,
  companionMessages,
  type CompanionMessage,
  type Database,
  type NewCompanionMessage,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** One stored line as the reads return it. */
export type CompanionHistoryRow = Pick<
  CompanionMessage,
  | "id"
  | "role"
  | "bodyText"
  | "ttsText"
  | "readAloud"
  | "suggestedOptions"
  | "suggestedFollowups"
  | "newsLinks"
  | "createdAt"
>;

/** One stored line a model call may read: who said it, what, and when. */
export interface CompanionModelLine {
  readonly role: CompanionMessage["role"];
  readonly text: string;
  readonly createdAt: Date;
}

/** The worker's rolling summary record. `summary` null is a watermark-only record. */
export interface CompanionSummaryRecord {
  readonly summary: string | null;
  readonly foldedThrough: Date;
}

/**
 * `companion_messages` + `companion_conversation_summaries` (migration 0135, #2297) — DATABASE
 * ACCESS ONLY. What is stored, when, and what a missing table means are `CompanionHistoryService`'s
 * decisions; every method here simply runs its statement and lets a failure throw.
 *
 * Its own file, not `ChatCompanionRepository`, which holds the companion's READS of other modules'
 * tables and pins that it writes nothing. These two tables are the companion's own.
 *
 * EVERY READ IS ONE INDEXED SCAN of `companion_messages_worker_created_idx`
 * (`worker_id, created_at DESC NULLS FIRST`): the newest lines first, filtered to the window,
 * limited, and handed back oldest first.
 */
@Injectable()
export class CompanionHistoryRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The newest `limit` lines after `since`, OLDEST FIRST. */
  async listSince(workerId: string, since: Date, limit: number): Promise<CompanionHistoryRow[]> {
    const rows = await this.db
      .select({
        id: companionMessages.id,
        role: companionMessages.role,
        bodyText: companionMessages.bodyText,
        ttsText: companionMessages.ttsText,
        readAloud: companionMessages.readAloud,
        suggestedOptions: companionMessages.suggestedOptions,
        suggestedFollowups: companionMessages.suggestedFollowups,
        newsLinks: companionMessages.newsLinks,
        createdAt: companionMessages.createdAt,
      })
      .from(companionMessages)
      .where(and(eq(companionMessages.workerId, workerId), gt(companionMessages.createdAt, since)))
      .orderBy(desc(companionMessages.createdAt))
      .limit(limit);
    return rows.reverse();
  }

  /**
   * The newest `limit` lines after `since` that a later model call may read (`model_context`),
   * OLDEST FIRST — the reply's recent turns and the summary fold's input.
   */
  async listModelLinesSince(
    workerId: string,
    since: Date,
    limit: number,
  ): Promise<CompanionModelLine[]> {
    const rows = await this.db
      .select({
        role: companionMessages.role,
        text: companionMessages.bodyText,
        createdAt: companionMessages.createdAt,
      })
      .from(companionMessages)
      .where(
        and(
          eq(companionMessages.workerId, workerId),
          gt(companionMessages.createdAt, since),
          eq(companionMessages.modelContext, true),
        ),
      )
      .orderBy(desc(companionMessages.createdAt))
      .limit(limit);
    return rows.reverse();
  }

  /**
   * Append lines. A line whose (worker, submission, role) is already stored is skipped — `ON
   * CONFLICT DO NOTHING` over the partial unique index — so a replayed submission writes nothing.
   * Returns how many lines were written.
   */
  async append(lines: readonly NewCompanionMessage[]): Promise<number> {
    if (lines.length === 0) return 0;
    const written = await this.db
      .insert(companionMessages)
      .values([...lines])
      .onConflictDoNothing()
      .returning({ id: companionMessages.id });
    return written.length;
  }

  /**
   * Append ONE line only while the worker has no line after `since` — the recap bubble that heads a
   * new conversation. One statement (`INSERT … SELECT … WHERE NOT EXISTS`), so a second open that
   * already sees a line writes nothing. True when it wrote.
   */
  async appendIfNoneSince(line: NewCompanionMessage, since: Date): Promise<boolean> {
    const result = await this.db.execute(sql`
      INSERT INTO ${companionMessages} (
        "worker_id", "role", "body_text", "tts_text", "read_aloud",
        "suggested_options", "suggested_followups", "news_links", "model_context", "created_at"
      )
      SELECT
        ${line.workerId}::uuid, ${line.role}::text, ${line.bodyText}::text,
        ${line.ttsText ?? null}::text, ${line.readAloud ?? null}::boolean,
        ${jsonOrNull(line.suggestedOptions)}::jsonb, ${jsonOrNull(line.suggestedFollowups)}::jsonb,
        ${jsonOrNull(line.newsLinks)}::jsonb, ${line.modelContext ?? false}::boolean,
        ${(line.createdAt ?? new Date()).toISOString()}::timestamptz
      WHERE NOT EXISTS (
        SELECT 1 FROM ${companionMessages}
        WHERE ${companionMessages.workerId} = ${line.workerId}::uuid
          AND ${companionMessages.createdAt} > ${since.toISOString()}::timestamptz
      )
      RETURNING "id"
    `);
    // postgres-js hands back the RETURNING rows as an array.
    return Array.isArray(result) && result.length > 0;
  }

  /**
   * The worker's summary record — only while it is LIVE: the newest line it covers
   * (`folded_through`) is still inside the window (after `since`). Undefined otherwise (none, or
   * expired).
   *
   * BY ITS OWN WATERMARK, NEVER BY "ANY LINE". A record whose lines have all left the window has
   * expired even when the worker has written since — a fresh line before the daily sweep must not
   * revive notes about a conversation that is gone (#2297 security review).
   */
  async findLiveSummary(
    workerId: string,
    since: Date,
  ): Promise<CompanionSummaryRecord | undefined> {
    const rows = await this.db
      .select({
        summary: companionConversationSummaries.summary,
        foldedThrough: companionConversationSummaries.foldedThrough,
      })
      .from(companionConversationSummaries)
      .where(
        and(
          eq(companionConversationSummaries.workerId, workerId),
          gt(companionConversationSummaries.foldedThrough, since),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * Store the worker's summary record. MONOTONIC: an existing record is replaced only by one whose
   * watermark is LATER, so a slow fold can never overwrite a newer one. True when it wrote.
   *
   * `replaceExpired`: the caller found no LIVE record, so whatever row exists belongs to an expired
   * conversation and is replaced whatever its watermark says.
   */
  async upsertSummary(
    workerId: string,
    record: CompanionSummaryRecord,
    replaceExpired: boolean,
  ): Promise<boolean> {
    const written = await this.db
      .insert(companionConversationSummaries)
      .values({
        workerId,
        summary: record.summary,
        foldedThrough: record.foldedThrough,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: companionConversationSummaries.workerId,
        set: {
          summary: record.summary,
          foldedThrough: record.foldedThrough,
          updatedAt: new Date(),
        },
        setWhere: replaceExpired
          ? undefined
          : lt(companionConversationSummaries.foldedThrough, record.foldedThrough),
      })
      .returning({ workerId: companionConversationSummaries.workerId });
    return written.length > 0;
  }

  /** RETENTION: delete up to `limit` lines older than `cutoff`. Returns how many. */
  async deleteLinesBefore(cutoff: Date, limit: number): Promise<number> {
    const batch = this.db
      .select({ id: companionMessages.id })
      .from(companionMessages)
      .where(lt(companionMessages.createdAt, cutoff))
      .limit(limit);
    const deleted = await this.db
      .delete(companionMessages)
      .where(and(inArray(companionMessages.id, batch), lt(companionMessages.createdAt, cutoff)))
      .returning({ id: companionMessages.id });
    return deleted.length;
  }

  /**
   * RETENTION: delete every EXPIRED summary — the newest line it covers is at or before `cutoff`
   * (the liveness rule of {@link findLiveSummary}, inverted). Returns how many.
   */
  async deleteExpiredSummaries(cutoff: Date): Promise<number> {
    const deleted = await this.db
      .delete(companionConversationSummaries)
      .where(lte(companionConversationSummaries.foldedThrough, cutoff))
      .returning({ workerId: companionConversationSummaries.workerId });
    return deleted.length;
  }
}

/** A jsonb parameter: the value as JSON text, or SQL NULL. */
function jsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}
