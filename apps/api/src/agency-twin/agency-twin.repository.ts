import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray } from "drizzle-orm";
import {
  disarmAgencyTwins,
  events,
  filterAgencyJobIds,
  listAgencyJobIds,
  syncAgencyTwin,
  type AgencyTwinContext,
  type AgencyTwinDisarmed,
  type AgencyTwinEmitter,
  type AgencyTwinSyncOutcome,
  type Database,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** The `job.*` events the agency service already emits — the sync's event trigger (§5.1). */
export const AGENCY_JOB_EVENT_NAMES = ["job.created", "job.updated", "job.closed"] as const;

/**
 * Data access for the ADR-0050 agency-twin sync. A thin adapter over the shared core in
 * `@badabhai/db` (`./agency-twin`), which the `db:sync:agency-twins` CLI runs too — so the api
 * and the CLI cannot write different twins. Plus the one read only the api needs: the event poll.
 */
@Injectable()
export class AgencyTwinRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** One job, one transaction, applied (see `syncAgencyTwin`). */
  sync(
    jobId: string,
    ctx: AgencyTwinContext,
    emit: AgencyTwinEmitter,
  ): Promise<AgencyTwinSyncOutcome> {
    return syncAgencyTwin(this.db, jobId, ctx, { apply: true, emit });
  }

  /** The kill switch's one bounded statement (see `disarmAgencyTwins`). */
  disarm(
    limit: number,
    emit: (tx: Database, moved: AgencyTwinDisarmed) => Promise<void>,
  ): Promise<AgencyTwinDisarmed[]> {
    return disarmAgencyTwins(this.db, limit, emit);
  }

  /** The sweep's keyset page of agency job ids. */
  listAgencyJobIds(afterId: string | null, limit: number): Promise<string[]> {
    return listAgencyJobIds(this.db, afterId, limit);
  }

  /**
   * THE EVENT POLL (ADR-0050 §5 trigger 1) — the AGENCY job ids named by a `job.created`,
   * `job.updated` or `job.closed` event since `since`. A sliding window over the spine rather
   * than a cursor: the sync is idempotent, so re-reading an event re-syncs to the same row and
   * writes nothing. Served by `events_occurred_at_idx` (a short range), then one PK probe to keep
   * only agency rows. Bounded by `limit`; anything past it is the sweep's.
   */
  async recentAgencyJobIds(since: Date, limit: number): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ subjectId: events.subjectId })
      .from(events)
      .where(
        and(
          gte(events.occurredAt, since),
          inArray(events.eventName, [...AGENCY_JOB_EVENT_NAMES]),
          eq(events.subjectType, "job"),
        ),
      )
      .limit(limit);
    const ids = rows.map((r) => r.subjectId).filter((id): id is string => typeof id === "string");
    return filterAgencyJobIds(this.db, ids);
  }
}
