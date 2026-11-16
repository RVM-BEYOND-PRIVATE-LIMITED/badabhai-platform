import { Inject, Injectable } from "@nestjs/common";
import { sql as dsql } from "drizzle-orm";
import { workerActivity, type Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import { lastActiveDayOf } from "./worker-activity";

/**
 * `worker_activity` (#2753 items 4 and 7, migration 0168): the days a worker was active, and the
 * API's ONE read of his last active day.
 *
 * NOTHING CALLS THIS WHILE `WORKER_ACTIVITY_ENABLED` IS OFF. The switch is read by
 * `WorkerActivityService` (and the agency list's order), never here, so this class can stay a
 * plain data seam; every caller goes through the service. That is what lets migration 0168 be
 * applied before the switch rather than before the deploy.
 *
 * IDS AND DATES ONLY, in and out: a worker id and an IST day. No route, device or time of day is
 * ever written, and the read returns a day, never a timestamp.
 */
@Injectable()
export class WorkerActivityRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Records that he was active on `activeOn` (an IST `yyyy-mm-dd`). Idempotent: the primary key
   * (worker, day) makes every write after the first of the day a no-op, across processes and
   * restarts, so a caller's per-process cache is an optimisation and never the guarantee.
   *
   * Reusable by any producer that knows a worker id (the request interceptor, a Campus
   * application, the monthly check of a later part): it takes the day, never "now", so the caller
   * decides which day an event belongs to.
   */
  async touch(workerId: string, activeOn: string): Promise<void> {
    await this.db
      .insert(workerActivity)
      .values({ workerId, activeOn })
      .onConflictDoNothing({ target: [workerActivity.workerId, workerActivity.activeOn] });
  }

  /**
   * Each worker's last active day (`yyyy-mm-dd`, IST), for a whole page in ONE statement: the
   * newest `worker_activity` day and the newest `worker_devices.last_seen_at`, merged by
   * {@link lastActiveDayOf} (the later of the two; the device term covers the time before the
   * table). A worker with neither is absent from the map.
   *
   * KEYED BY THE LOWER-CASE ID, as Postgres prints a uuid; look rows up with `.toLowerCase()`.
   *
   * EVERY DEVICE COUNTS, revoked ones too: a sign-out ends a device's session, not the fact that
   * he used the app on it. (The #2747 pre-pay fact and the card's band read devices the same way.)
   *
   * The day of `active_on` leaves the database as TEXT (`to_char`), never as a `date`: a driver
   * that turns a `date` into a JavaScript Date at local midnight would shift it a day on a server
   * west of UTC. The device time leaves as a timestamp and is converted by the one IST converter.
   */
  async lastActiveDays(
    workerIds: readonly string[],
    now: Date = new Date(),
  ): Promise<Map<string, string>> {
    const ids = [...new Set(workerIds.map((id) => id.toLowerCase()))];
    const out = new Map<string, string>();
    if (ids.length === 0) return out;
    const rows = await this.db.execute<{
      worker_id: string;
      active_on: string | null;
      last_seen_at: Date | string | null;
    }>(dsql`
      SELECT w.id AS worker_id,
             (
               SELECT to_char(max(wa.active_on), 'YYYY-MM-DD')
               FROM worker_activity wa
               WHERE wa.worker_id = w.id
             ) AS active_on,
             (
               SELECT max(wd.last_seen_at)
               FROM worker_devices wd
               WHERE wd.worker_id = w.id
             ) AS last_seen_at
      FROM unnest(${dsql.param(ids)}::uuid[]) AS w(id)
    `);
    for (const r of rows as unknown as Array<Record<string, unknown>>) {
      const seen = r.last_seen_at;
      const day = lastActiveDayOf(
        typeof r.active_on === "string" ? r.active_on : null,
        seen instanceof Date || typeof seen === "string" ? seen : null,
        now,
      );
      if (day !== null) out.set(String(r.worker_id).toLowerCase(), day);
    }
    return out;
  }
}
