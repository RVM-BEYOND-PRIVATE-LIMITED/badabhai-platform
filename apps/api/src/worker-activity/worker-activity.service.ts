import { Inject, Injectable, Logger } from "@nestjs/common";
import { SERVER_CONFIG } from "../config/config.module";
import { sqlStateOf } from "../common/db-error";
import {
  isUndefinedTable,
  WorkerActivityRepository,
  warnWorkerActivityTableMissing,
} from "./worker-activity.repository";
import {
  DEFAULT_NOT_RECENTLY_ACTIVE_DAYS,
  isNotRecentlyActive,
  istDayOf,
  workerActivityEnabled,
  type WorkerActivityConfig,
} from "./worker-activity";

/**
 * Last active, ONE DEFINITION (#2753 items 4 and 7), behind `WORKER_ACTIVITY_ENABLED`.
 *
 * WRITES are fire-and-forget: {@link touch} and {@link recordNow} return nothing, never await,
 * never throw, and log only the worker id and the SQLSTATE when the write fails (a missing table,
 * 42P01, is reported once per process instead: every write would fail the same way). Activity is a
 * side-signal; it must never slow or fail the request that carries it (the interceptor's rule).
 *
 * READS ({@link lastActiveDays}) answer `null` while the switch is off and run NO query, so every
 * caller can keep today's computation and today's response shape with one `null` check. With it on
 * they are one statement per page, never one per row.
 *
 * OFF IS TODAY EXACTLY. Nothing here touches `worker_activity` while the switch is off, which is
 * what makes migration 0168 apply-before-the-switch.
 */
@Injectable()
export class WorkerActivityService {
  private readonly logger = new Logger(WorkerActivityService.name);

  constructor(
    private readonly repo: WorkerActivityRepository,
    @Inject(SERVER_CONFIG) private readonly config: WorkerActivityConfig,
  ) {}

  /** Is the switch on? Read per call (cheap), so a test can flip the config object it handed in. */
  get enabled(): boolean {
    return workerActivityEnabled(this.config);
  }

  /** `NOT_RECENTLY_ACTIVE_DAYS`, or the owner's default when the config does not carry it. */
  get thresholdDays(): number {
    const days = this.config?.NOT_RECENTLY_ACTIVE_DAYS;
    return typeof days === "number" && Number.isInteger(days) && days >= 1
      ? days
      : DEFAULT_NOT_RECENTLY_ACTIVE_DAYS;
  }

  /**
   * Fire-and-forget: he was active on `activeOn` (IST `yyyy-mm-dd`). A no-op while the switch is
   * off. The caller owns any per-process de-duplication; the table's primary key is the guarantee.
   */
  touch(workerId: string, activeOn: string): void {
    if (!this.enabled) return;
    void this.repo.touch(workerId, activeOn).catch((err: unknown) => {
      // Switched on before migration 0168: the day is lost, silently but for one line per process
      // (the read falls back to the device day, so nothing a company or agency sees breaks).
      if (isUndefinedTable(err)) {
        warnWorkerActivityTableMissing();
        return;
      }
      // Ids and a closed code only: the error text could quote the statement's parameters.
      this.logger.warn(
        `worker activity: day not recorded (worker=${workerId}, sqlstate=${sqlStateOf(err) ?? "none"})`,
      );
    });
  }

  /** Fire-and-forget: he was active today (IST). For producers outside a worker session (Campus). */
  recordNow(workerId: string, now: Date = new Date()): void {
    if (!this.enabled) return;
    this.touch(workerId, istDayOf(now));
  }

  /**
   * Each worker's last active day for a page (lower-case id → `yyyy-mm-dd`), or `null` — and no
   * query — while the switch is off. One statement for the whole page.
   */
  async lastActiveDays(
    workerIds: readonly string[],
    now: Date = new Date(),
  ): Promise<Map<string, string> | null> {
    if (!this.enabled) return null;
    return this.repo.lastActiveDays(workerIds, now);
  }

  /**
   * The mark for one worker, from a page's {@link lastActiveDays} map: more than
   * `NOT_RECENTLY_ACTIVE_DAYS` since his last active day, as of `now`'s IST day. Pure.
   */
  notRecentlyActive(
    days: ReadonlyMap<string, string>,
    workerId: string,
    now: Date = new Date(),
  ): boolean {
    return isNotRecentlyActive(days.get(workerId.toLowerCase()), istDayOf(now), this.thresholdDays);
  }
}
