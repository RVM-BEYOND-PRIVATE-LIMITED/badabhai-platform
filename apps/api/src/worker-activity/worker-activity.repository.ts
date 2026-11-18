import { Inject, Injectable, Logger } from "@nestjs/common";
import { sql as dsql, type SQL } from "drizzle-orm";
import { workerActivity, type Database } from "@badabhai/db";
import { sqlStateOf } from "../common/db-error";
import { DATABASE } from "../database/database.module";
import { lastActiveDayOf } from "./worker-activity";

/** Postgres `undefined_table`: here, migration 0168 not applied yet. */
const PG_UNDEFINED_TABLE = "42P01";

/** Is `err` a missing table (42P01), wrapped by drizzle or not? */
export function isUndefinedTable(err: unknown): boolean {
  return sqlStateOf(err) === PG_UNDEFINED_TABLE;
}

const missingTableLogger = new Logger("WorkerActivityRepository");
let missingTableWarned = false;

/**
 * The switch is on but `worker_activity` is not there: say so ONCE per process, naming the
 * migration and the code (no worker id, no SQL text), however many reads and writes then fall
 * back. Every caller that tolerates 42P01 on this table reports through here, so the operator sees
 * one line, not one per request.
 */
export function warnWorkerActivityTableMissing(): void {
  if (missingTableWarned) return;
  missingTableWarned = true;
  missingTableLogger.warn(
    `worker_activity is missing (sqlstate=${PG_UNDEFINED_TABLE}): WORKER_ACTIVITY_ENABLED is on ` +
      "but migration 0168_worker_activity is not applied. Activity is not recorded, and the " +
      "last-active day falls back to the device sighting until it is.",
  );
}

/**
 * `worker_activity` (#2753 items 4 and 7, migration 0168): the days a worker was active, and the
 * API's ONE read of his last active day.
 *
 * NOTHING CALLS THIS WHILE `WORKER_ACTIVITY_ENABLED` IS OFF. The switch is read by
 * `WorkerActivityService` (and the agency list's order), never here, so this class can stay a
 * plain data seam; every caller goes through the service. That is what lets migration 0168 be
 * applied before the switch rather than before the deploy.
 *
 * SWITCHED ON BEFORE 0168, NOTHING ANSWERS 500. The read catches 42P01 (and only 42P01) and
 * answers the device-only day, so the company lists, the inbox, search and the agency list keep
 * working and the mark is computed from that day; the writes are lost (the service drops them). One
 * warning per process says which migration is missing. Any other error still throws.
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
   * WITHOUT THE TABLE (42P01, migration 0168 not applied) it answers the device term alone, logs
   * once per process ({@link warnWorkerActivityTableMissing}) and never fails the page. Any other
   * error propagates.
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
    const select = (activeOn: SQL) =>
      this.db.execute<{
        worker_id: string;
        active_on: string | null;
        last_seen_at: Date | string | null;
      }>(dsql`
        SELECT w.id AS worker_id,
               ${activeOn} AS active_on,
               (
                 SELECT max(wd.last_seen_at)
                 FROM worker_devices wd
                 WHERE wd.worker_id = w.id
               ) AS last_seen_at
        FROM unnest(${dsql.param(ids)}::uuid[]) AS w(id)
      `);
    let rows: unknown;
    try {
      rows = await select(dsql`(
        SELECT to_char(max(wa.active_on), 'YYYY-MM-DD')
        FROM worker_activity wa
        WHERE wa.worker_id = w.id
      )`);
    } catch (err) {
      // Switched on before 0168: the device term alone, which is exactly the merge's device term,
      // so the day (and the mark computed from it) is what it was before the table existed. Not a
      // transaction, so the failed statement aborts nothing and the retry can run.
      if (!isUndefinedTable(err)) throw err;
      warnWorkerActivityTableMissing();
      rows = await select(dsql`NULL::text`);
    }
    for (const r of rows as Array<Record<string, unknown>>) {
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
