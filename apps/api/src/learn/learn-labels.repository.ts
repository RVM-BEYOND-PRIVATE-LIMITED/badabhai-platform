import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, inArray, isNull, sql as dsql } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import { events, learnLabels, learnLabelsCursor } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** The spine events this producer projects. One source of truth for reader + tests. */
export const LEARN_EVENT_NAMES = [
  "feed.shown_v2",
  "application.submitted",
  "application.skipped",
] as const;

/**
 * How far before the stored watermark each tick re-reads. Delivery is at-least-once in
 * practice (a tick can die mid-batch), so the window deliberately OVERLAPS and relies on
 * idempotency (UNIQUE impression key / pending-resolution guard) instead of exact-once.
 */
const WATERMARK_OVERLAP_MS = 5 * 60_000;

/** The one cursor row id. */
const CURSOR_ID = "singleton";

/** A `feed.shown_v2` payload — registry-validated ids/ints/booleans only. */
interface ShownV2Payload {
  worker_id: string;
  job_posting_id: string;
  rank: number;
  match_tier: number;
  boosted: boolean;
  matched_skill_id: string;
}

interface ApplicationPayload {
  worker_id: string;
  job_id: string;
}

/** What one ingest batch did — counts only (the processor logs + returns this). */
export interface LearnIngestSummary {
  impressionsIngested: number;
  submittedResolved: number;
  skippedResolved: number;
  /** Events seen but not applicable (legacy subject shapes, missing subjects). */
  skippedEvents: number;
}

/**
 * Data access for the LEARN label store (migration 0091) plus the spine reads it feeds
 * from. Pure data access: routing decisions live in LearnLabelsService.
 *
 * EVERY write is idempotent by construction:
 *  - impression insert: ON CONFLICT (impression_event_id) DO NOTHING;
 *  - resolution: guarded by resolved_at IS NULL, so a replay cannot flip an outcome.
 */
@Injectable()
export class LearnLabelsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * The next batch of label-relevant spine events after the watermark (minus overlap).
   * Ordered ASC so the watermark only ever moves forward over CONSECUTIVE rows; bounded
   * per tick so a backlog drains across ticks.
   */
  async readEventBatch(afterMs: number, limit: number): Promise<LearnEventRow[]> {
    const cutoff = new Date(afterMs - WATERMARK_OVERLAP_MS);
    const rows = await this.db
      .select({
        id: events.id,
        eventName: events.eventName,
        subjectType: events.subjectType,
        payload: events.payload,
        createdAt: events.createdAt,
      })
      .from(events)
      .where(
        and(inArray(events.eventName, [...LEARN_EVENT_NAMES]), gt(events.createdAt, cutoff)),
      )
      .orderBy(events.createdAt)
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      eventName: r.eventName,
      subjectType: r.subjectType,
      payload: r.payload as Record<string, unknown>,
      createdAt: r.createdAt,
    }));
  }

  async ingestImpression(ev: LearnEventRow): Promise<boolean> {
    const p = ev.payload as unknown as ShownV2Payload;
    if (
      typeof p.worker_id !== "string" ||
      typeof p.job_posting_id !== "string" ||
      typeof p.rank !== "number"
    ) {
      return false;
    }
    const inserted = await this.db
      .insert(learnLabels)
      .values({
        workerId: p.worker_id,
        jobPostingId: p.job_posting_id,
        impressionEventId: ev.id,
        rank: p.rank,
        matchTier: p.match_tier,
        boosted: p.boosted === true,
        matchedSkillId: String(p.matched_skill_id ?? ""),
        shownAt: ev.createdAt,
      })
      .onConflictDoNothing({ target: learnLabels.impressionEventId })
      .returning({ id: learnLabels.id });
    return inserted.length > 0;
  }

  /**
   * Resolve every still-pending impression of this (worker, posting) pair to the
   * deciding outcome. reach-learn treats applications as SET MEMBERSHIP per pair, so
   * all prior undecided impressions of the pair share the outcome — the last one before
   * the apply is simply the strongest of them.
   */
  async resolvePending(
    ev: LearnEventRow,
    outcome: "applied" | "skipped",
  ): Promise<boolean> {
    const p = ev.payload as unknown as ApplicationPayload;
    if (typeof p.worker_id !== "string" || typeof p.job_id !== "string") return false;
    // Only V1 decisions carry a POSTING id (subject_type 'job_posting'); legacy
    // `job`-subjected events point at retired `jobs` rows and must not poison labels
    // with ids that mean nothing here.
    if (ev.subjectType !== "job_posting") return false;

    const skipReason =
      outcome === "skipped" && typeof ev.payload.reason === "string"
        ? (ev.payload.reason as never)
        : null;

    const updated = await this.db
      .update(learnLabels)
      .set({
        outcome,
        label: outcome === "applied" ? 1 : 0,
        outcomeEventId: ev.id,
        skipReason,
        resolvedAt: ev.createdAt,
        updatedAt: dsql`now()`,
      })
      .where(
        and(
          eq(learnLabels.workerId, p.worker_id),
          eq(learnLabels.jobPostingId, p.job_id),
          isNull(learnLabels.resolvedAt),
        ),
      )
      .returning({ id: learnLabels.id });
    return updated.length > 0;
  }

  async getWatermark(): Promise<number> {
    const rows = await this.db
      .select({ watermark: learnLabelsCursor.watermark })
      .from(learnLabelsCursor)
      .where(eq(learnLabelsCursor.id, CURSOR_ID))
      .limit(1);
    return rows[0]?.watermark?.getTime() ?? Date.now() - WATERMARK_OVERLAP_MS;
  }

  /** Advance the cursor; created lazily on first write (upsert by singleton id). */
  async setWatermark(ms: number): Promise<void> {
    await this.db
      .insert(learnLabelsCursor)
      .values({ id: CURSOR_ID, watermark: new Date(Math.min(ms, Date.now())) })
      .onConflictDoUpdate({
        target: learnLabelsCursor.id,
        set: { watermark: new Date(Math.min(ms, Date.now())), updatedAt: dsql`now()` },
      });
  }

  /**
   * Dry-run report: how many label-relevant events exist after the watermark — counts
   * only, no ids, nothing written.
   */
  async countRelevantAfter(afterMs: number): Promise<number> {
    const rows = await this.db
      .select({ n: dsql<number>`count(*)::int` })
      .from(events)
      .where(
        and(
          inArray(events.eventName, [...LEARN_EVENT_NAMES]),
          gt(events.createdAt, new Date(afterMs - WATERMARK_OVERLAP_MS)),
        ),
      );
    return rows[0]?.n ?? 0;
  }
}

export interface LearnEventRow {
  id: string;
  eventName: string;
  subjectType: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
}
