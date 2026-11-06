import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, inArray, sql as dsql } from "drizzle-orm";
import {
  adminCandidateIndex,
  adminCandidateIndexCursor,
  agencyInvites,
  events,
  invites,
  workerAiCostTotals,
  workers,
  type AdminCandidateIndexRow,
  type Database,
  type NewAdminCandidateIndexRow,
} from "@badabhai/db";
import { DATABASE } from "../../database/database.module";
import { ADMIN_CANDIDATE_EVENT_NAMES } from "./candidate-index.events";

/**
 * DB reads/writes for the candidate read table (B4, #2557). SELECT-ONLY except
 * the projector's idempotent upsert and the cursor advance. NO business logic:
 * values arrive fully computed from the projector.
 */
@Injectable()
export class CandidateIndexRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Idempotent upsert — re-projection of the same worker converges, never duplicates. */
  async upsertRow(row: NewAdminCandidateIndexRow): Promise<void> {
    const { workerId: _omit, ...set } = row;
    await this.db
      .insert(adminCandidateIndex)
      .values(row)
      .onConflictDoUpdate({
        target: adminCandidateIndex.workerId,
        set: { ...set, projectedAt: dsql`now()` },
      });
  }

  /** The projected row, for the drift check. */
  async readRow(workerId: string): Promise<AdminCandidateIndexRow | undefined> {
    const rows = await this.db
      .select()
      .from(adminCandidateIndex)
      .where(eq(adminCandidateIndex.workerId, workerId))
      .limit(1);
    return rows[0];
  }

  /** Worker ids for the nightly rebuild / backfill, keyset-paged (stable, resumable). */
  async listWorkerIds(limit: number, afterId: string | null): Promise<string[]> {
    const rows = await this.db
      .select({ id: workers.id })
      .from(workers)
      .where(afterId === null ? dsql`TRUE` : gt(workers.id, afterId))
      .orderBy(asc(workers.id))
      .limit(limit);
    return rows.map((r) => r.id);
  }

  /** Spine events after the watermark (minus the overlap window), oldest first. */
  async readEventBatch(
    afterMs: number,
    overlapMs: number,
    limit: number,
  ): Promise<{ createdAt: Date; subjectType: string; subjectId: string | null; payload: unknown }[]> {
    const cutoff = new Date(afterMs - overlapMs);
    return this.db
      .select({
        createdAt: events.createdAt,
        subjectType: events.subjectType,
        subjectId: events.subjectId,
        payload: events.payload,
      })
      .from(events)
      .where(
        and(
          inArray(events.eventName, [...ADMIN_CANDIDATE_EVENT_NAMES]),
          gt(events.createdAt, cutoff),
        ),
      )
      .orderBy(asc(events.createdAt))
      .limit(limit);
  }

  /** The cursor watermark, or 0 (epoch) when the cursor row does not exist yet. */
  async getWatermark(): Promise<number> {
    const rows = await this.db
      .select({ watermark: adminCandidateIndexCursor.watermark })
      .from(adminCandidateIndexCursor)
      .where(eq(adminCandidateIndexCursor.id, "singleton"))
      .limit(1);
    return rows[0]?.watermark?.getTime() ?? 0;
  }

  /** Advance the cursor; created lazily on first write (upsert by singleton id). */
  async setWatermark(ms: number): Promise<void> {
    await this.db
      .insert(adminCandidateIndexCursor)
      .values({ id: "singleton", watermark: new Date(Math.min(ms, Date.now())) })
      .onConflictDoUpdate({
        target: adminCandidateIndexCursor.id,
        set: { watermark: new Date(Math.min(ms, Date.now())), updatedAt: dsql`now()` },
      });
  }

  /**
   * The worker's accrued AI spend (`worker_ai_cost_totals`), as the numeric
   * string the driver returns — `"0"` when the worker has cost nothing (no row).
   */
  async readAiCostTotal(workerId: string): Promise<string> {
    const rows = await this.db
      .select({ total: workerAiCostTotals.totalCostInr })
      .from(workerAiCostTotals)
      .where(eq(workerAiCostTotals.workerId, workerId))
      .limit(1);
    return rows[0]?.total ?? "0";
  }

  /**
   * First-touch referral label: the earliest attribution row pointing at this
   * worker (`invites` / `agency_invites` by `invited_worker_id`), as
   * `<origin>:<campaign ?? channel>` — stable codes only, never a referrer's
   * identity (the inviter id is never read). `null` when unattributed.
   */
  async readReferralSource(workerId: string): Promise<string | null> {
    const [inviteRows, agencyRows] = await Promise.all([
      this.db
        .select({
          channel: invites.channel,
          campaign: invites.campaign,
          createdAt: invites.createdAt,
        })
        .from(invites)
        .where(eq(invites.invitedWorkerId, workerId))
        .orderBy(asc(invites.createdAt))
        .limit(1),
      this.db
        .select({
          channel: agencyInvites.channel,
          campaign: agencyInvites.campaign,
          createdAt: agencyInvites.createdAt,
        })
        .from(agencyInvites)
        .where(eq(agencyInvites.invitedWorkerId, workerId))
        .orderBy(asc(agencyInvites.createdAt))
        .limit(1),
    ]);
    const invite = inviteRows[0];
    const agency = agencyRows[0];
    const first =
      invite && agency
        ? invite.createdAt <= agency.createdAt
          ? { origin: "invite", ...invite }
          : { origin: "agency", ...agency }
        : invite
          ? { origin: "invite", ...invite }
          : agency
            ? { origin: "agency", ...agency }
            : null;
    if (!first) return null;
    return `${first.origin}:${first.campaign ?? first.channel}`;
  }
}
