import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { Database } from "@badabhai/db";
import { SERVER_CONFIG } from "../../config/config.module";
import { adminNumbersEnabled, numbersFreezeAfterDays } from "./admin-numbers.flag";
import {
  NUMBERS_BASELINE_FROM,
  NUMBERS_DEFINITION_VERSION,
  NUMBERS_FREEZE_CLASSES,
  numbersFreezeClassOf,
  numbersFreezeWindowDays,
  type NumbersFreezeClass,
} from "./definitions";
import type { NumbersMetricCells } from "./metrics/cells";
import { computeCohortWeek, computeNumbersWeek } from "./metrics/compute-week";
import { NumbersWeeklyRepository, type NumbersSnapshotCellRow } from "./numbers-weekly.repository";
import { weekRange, weekStartOf, weeksBetween } from "./week";

/** Postgres `undefined_table`: what a read of the snapshot answers before its migration. */
export const PG_UNDEFINED_TABLE = "42P01";
const DAY_MS = 24 * 60 * 60 * 1000;

/** What one sweep did — counts only (the BullMQ job-inspection surface). */
export interface NumbersSweepResult {
  /** False when ADMIN_NUMBERS_ENABLED is off (nothing was read) or the tables are missing. */
  readonly armed: boolean;
  /** Weeks recomputed and left open (the sweep comes back to them). */
  readonly computed: number;
  /** Weeks of which this run froze a class (recomputed one last time). */
  readonly frozen: number;
  /** Weeks skipped because both their classes were already frozen. */
  readonly skipped: number;
}

let missingTablesWarned = false;

/** The rows of one freeze class. */
export function rowsOfClass(
  rows: readonly NumbersSnapshotCellRow[],
  cls: NumbersFreezeClass,
): NumbersSnapshotCellRow[] {
  return rows.filter((r) => numbersFreezeClassOf(r.metric) === cls);
}

/** Flatten a week's metric cells into the rows `numbers_weekly` stores. */
export function snapshotRowsOf(
  week: string,
  metrics: readonly NumbersMetricCells[],
  definitionVersion: number = NUMBERS_DEFINITION_VERSION,
): NumbersSnapshotCellRow[] {
  return metrics.flatMap((m) =>
    m.cells.map((c) => ({
      weekStart: week,
      metric: m.metric,
      cityGroup: c.cityGroup,
      tradeGroup: c.tradeGroup,
      value: c.value,
      numerator: c.numerator,
      denominator: c.denominator,
      suppressed: c.suppressed,
      definitionVersion,
    })),
  );
}

/**
 * #2755 items 4 and 11 — THE WEEKLY SNAPSHOT: compute a week, the nightly sweep, the freeze.
 *
 * THE SWITCH FIRST. With `ADMIN_NUMBERS_ENABLED` off the sweep returns at once and names no
 * table: that is what makes the snapshot migration apply-before-the-switch. On before it, the
 * sweep finds the tables missing (one catalogue read), logs one warning per process and writes
 * nothing.
 *
 * EACH RUN recomputes every week from the baseline (the later of `NUMBERS_BASELINE_FROM` and the
 * week of the earliest source row) to the current one that is NOT frozen — so the first run
 * computes the history — one TRANSACTION PER WEEK: take the week's advisory lock, skip it if it is
 * frozen, otherwise compute it and replace its rows. A week whose freeze time has come
 * (`NUMBERS_FREEZE_AFTER_DAYS` after its Sunday ends) is written with `frozen_at` in that same
 * transaction, and the sweep never touches it again; only the logged recompute tool can.
 *
 * TWO FREEZE CLASSES PER WEEK (part C). The repeat-buying rows of a week are a COHORT: they are
 * complete only once the longest window (90 days) has elapsed after the week, so their freeze is
 * keyed on that window's end — 90 days plus `NUMBERS_FREEZE_AFTER_DAYS` after the week ends —
 * while the week's other rows freeze as above. Each class is replaced and frozen on its own
 * (`replaceWeek` takes the class), so a week whose `week` rows are frozen keeps them byte for
 * byte while its `cohort` rows are still recomputed nightly; a FROZEN ROW NEVER CHANGES. A week is
 * skipped only when both classes are frozen. A week frozen before part C shipped (no cohort row)
 * gets its cohort rows on the next run, frozen at once when their time has passed.
 *
 * SAFE ACROSS PROCESSES: two sweeps on two processes serialise on each week's lock; the later one
 * sees the earlier one's commit (a frozen week it skips, or rows it replaces with the same
 * figures), so a week is always one set of rows.
 */
@Injectable()
export class NumbersSnapshotService {
  private readonly logger = new Logger(NumbersSnapshotService.name);

  constructor(
    private readonly repo: NumbersWeeklyRepository,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /** `ADMIN_NUMBERS_ENABLED`, read per call through part A's one reader. */
  get enabled(): boolean {
    return adminNumbersEnabled(this.config);
  }

  /**
   * The instant a week's rows of `cls` freeze: `NUMBERS_FREEZE_AFTER_DAYS` days after the week
   * ends (`week`), or after its longest repeat window has elapsed (`cohort`, 90 days later).
   */
  freezesAt(week: string, cls: NumbersFreezeClass = "week"): Date {
    const days = numbersFreezeWindowDays(cls) + numbersFreezeAfterDays(this.config);
    return new Date(weekRange(week).toUtcExclusive.getTime() + days * DAY_MS);
  }

  /** Is the freeze time of the week's `cls` rows reached at `now`? */
  isDueToFreeze(week: string, now: Date, cls: NumbersFreezeClass = "week"): boolean {
    return now.getTime() >= this.freezesAt(week, cls).getTime();
  }

  /**
   * Every stored row of one week, computed from the sources on `tx` as of `asOf` (which decides
   * whether a repeat-buying window is still pending). `only: "cohort"` computes the cohort rows
   * alone (a week whose other rows are frozen).
   */
  async computeWeekRows(
    tx: Database,
    week: string,
    hasActivityTable: boolean,
    asOf: Date,
    only?: "cohort",
  ): Promise<NumbersSnapshotCellRow[]> {
    const sources = this.repo.sourcesFor(tx, hasActivityTable);
    const metrics =
      only === "cohort"
        ? await computeCohortWeek(sources, week, asOf)
        : await computeNumbersWeek(sources, week, asOf);
    return snapshotRowsOf(week, metrics);
  }

  /**
   * The first week the sweep computes: the later of `NUMBERS_BASELINE_FROM` and the week of the
   * earliest source row; the current week when there is no source row at all.
   */
  async firstWeek(now: Date): Promise<string> {
    const current = weekStartOf(now);
    const earliest = await this.repo.earliestSourceAt();
    if (earliest === null) return current;
    const fromData = weekStartOf(earliest);
    const first = fromData > NUMBERS_BASELINE_FROM ? fromData : NUMBERS_BASELINE_FROM;
    return first > current ? current : first;
  }

  /**
   * The nightly tick. Off: returns at once, no query. `onlyWeeks` narrows the run to those weeks
   * (the DB gate); the processor never passes it.
   */
  async sweep(now: Date = new Date(), onlyWeeks?: readonly string[]): Promise<NumbersSweepResult> {
    if (!this.enabled) return { armed: false, computed: 0, frozen: 0, skipped: 0 };
    let computed = 0;
    let frozen = 0;
    let skipped = 0;
    // A catalogue read, not a 42P01 caught: a missing SOURCE table (an unapplied lower migration)
    // must fail the tick loudly, never be mistaken for the snapshot's own migration.
    if (!(await this.repo.snapshotTablesExist())) {
      warnTablesMissingOnce(this.logger);
      return { armed: false, computed, frozen, skipped };
    }
    const hasActivityTable = await this.repo.workerActivityTableExists();
    const weeks = onlyWeeks ?? weeksBetween(await this.firstWeek(now), weekStartOf(now));
    for (const week of weeks) {
      // One week, one transaction: a failure rolls back that week alone, and the weeks before it
      // stay as committed.
      const outcome = await this.repo.withTransaction(async (tx) => {
        await this.repo.lockWeek(tx, week);
        const frozen = await this.repo.frozenClasses(tx, week);
        const open = NUMBERS_FREEZE_CLASSES.filter((cls) => !frozen.has(cls));
        if (open.length === 0) return "skipped" as const;
        const rows = await this.computeWeekRows(
          tx,
          week,
          hasActivityTable,
          now,
          frozen.has("week") ? "cohort" : undefined,
        );
        let froze = false;
        for (const cls of open) {
          const freeze = this.isDueToFreeze(week, now, cls);
          await this.repo.replaceWeek(
            tx,
            week,
            cls,
            rowsOfClass(rows, cls),
            now,
            freeze ? now : null,
          );
          froze ||= freeze;
        }
        return froze ? ("frozen" as const) : ("computed" as const);
      });
      if (outcome === "skipped") skipped += 1;
      else if (outcome === "frozen") frozen += 1;
      else computed += 1;
    }
    if (computed > 0 || frozen > 0) {
      this.logger.log(
        `numbers sweep: computed=${computed} frozen=${frozen} skipped_frozen=${skipped}`,
      );
    }
    return { armed: true, computed, frozen, skipped };
  }
}

/**
 * The switch is on but the snapshot tables are missing: say so ONCE per process, naming the
 * migration and the code, however many ticks meet it.
 */
function warnTablesMissingOnce(logger: Logger): void {
  if (missingTablesWarned) return;
  missingTablesWarned = true;
  logger.warn(
    `numbers_weekly is missing (sqlstate=${PG_UNDEFINED_TABLE}): ADMIN_NUMBERS_ENABLED is on but ` +
      "the numbers_weekly migration is not applied. GET /admin/numbers/weekly answers 503 and the " +
      "sweep writes nothing until it is.",
  );
}

/** For tests: forget that the missing-table warning was given. */
export function resetNumbersMissingTableWarningForTests(): void {
  missingTablesWarned = false;
}
