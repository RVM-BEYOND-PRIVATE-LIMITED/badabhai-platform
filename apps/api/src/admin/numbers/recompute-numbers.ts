import { parseArgs } from "node:util";
import { NUMBERS_RECOMPUTE_REASON_MAX, PRODUCTION_WRITE_FLAG } from "@badabhai/db";
import {
  NUMBERS_BASELINE_FROM,
  NUMBERS_DEFINITION_VERSION,
  NUMBERS_FREEZE_CLASSES,
} from "./definitions";
import { rowsOfClass, type NumbersSnapshotService } from "./numbers-snapshot.service";
import type { NumbersSnapshotCellRow, NumbersWeeklyRepository } from "./numbers-weekly.repository";
import { assertWeekStart, weekStartOf, weeksBetween } from "./week";

/**
 * #2755 item 4 — THE LOGGED RECOMPUTE of the weekly snapshot: the one way a FROZEN week changes.
 *
 * For a definition change (a bumped `NUMBERS_DEFINITION_VERSION`) or a repaired source, the
 * operator recomputes a span of weeks from the source tables under the CURRENT definitions.
 *
 *   - DRY RUN BY DEFAULT: every week is computed and compared with what is stored, and the
 *     differences are printed per metric (rows added, removed, changed). Nothing is written.
 *   - `--apply`: ONE transaction rewrites every week of the span (frozen ones included), each
 *     under its advisory lock, re-freezes the weeks whose freeze time has passed (`frozen_at` =
 *     now; a week not yet due stays open for the sweep), and writes ONE `numbers_recompute_log`
 *     row: the span, the definition version, the rows changed and the operator's reason. Each of a
 *     week's two freeze classes is re-frozen on its own time: its repeat-buying (cohort) rows only
 *     once their longest window has elapsed (part C).
 *
 * THE REASON IS THE OPERATOR'S OWN WORDS (1..500 characters). It is stored in the log row and
 * nowhere else: never printed, never logged, never put on an event.
 */

export const RECOMPUTE_NUMBERS_SCRIPT = "recompute-numbers";

/** The most weeks one run recomputes: two years. A longer span is two runs. */
export const RECOMPUTE_MAX_WEEKS = 104;

export interface RecomputeNumbersArgs {
  readonly fromWeek: string;
  readonly toWeek: string;
  readonly reason: string;
  readonly apply: boolean;
}

/** Strict argv parsing: an unknown flag, a bad week or a missing reason is an error, never a guess. */
export function parseRecomputeNumbersArgs(
  argv: readonly string[],
  now: Date = new Date(),
): RecomputeNumbersArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      from: { type: "string" },
      to: { type: "string" },
      reason: { type: "string" },
      apply: { type: "boolean", default: false },
      [PRODUCTION_WRITE_FLAG.replace(/^--/, "")]: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const fromWeek = values.from;
  const toWeek = values.to;
  if (fromWeek === undefined || toWeek === undefined) {
    throw new Error("--from <week> and --to <week> are required (each a Monday, yyyy-mm-dd)");
  }
  assertWeekStart(fromWeek);
  assertWeekStart(toWeek);
  if (fromWeek > toWeek) throw new Error(`--from ${fromWeek} is after --to ${toWeek}`);
  if (fromWeek < NUMBERS_BASELINE_FROM) {
    throw new Error(`--from is before the baseline week ${NUMBERS_BASELINE_FROM}`);
  }
  const current = weekStartOf(now);
  if (toWeek > current) throw new Error(`--to ${toWeek} is after the current week ${current}`);
  if (weeksBetween(fromWeek, toWeek).length > RECOMPUTE_MAX_WEEKS) {
    throw new Error(`a run recomputes at most ${RECOMPUTE_MAX_WEEKS} weeks`);
  }
  const reason = (values.reason ?? "").trim();
  if (reason.length < 1 || reason.length > NUMBERS_RECOMPUTE_REASON_MAX) {
    throw new Error(
      `--reason "<why>" is required: your own words, 1 to ${NUMBERS_RECOMPUTE_REASON_MAX} characters`,
    );
  }
  return { fromWeek, toWeek, reason, apply: values.apply === true };
}

/** What changed in one metric across the span. */
export interface MetricDiff {
  added: number;
  removed: number;
  changed: number;
}

const cellId = (r: NumbersSnapshotCellRow) => `${r.metric}|${r.cityGroup}|${r.tradeGroup}`;

function sameCell(a: NumbersSnapshotCellRow, b: NumbersSnapshotCellRow): boolean {
  return (
    a.value === b.value &&
    a.numerator === b.numerator &&
    a.denominator === b.denominator &&
    a.suppressed === b.suppressed &&
    a.definitionVersion === b.definitionVersion
  );
}

/**
 * The differences between one week's stored rows and its fresh ones, added into `into` per
 * metric: a fresh cell with no stored twin is `added`, a stored one with no fresh twin `removed`,
 * a pair whose figure, terms, suppression or version differ `changed`. Returns the week's total.
 */
export function diffWeekRows(
  stored: readonly NumbersSnapshotCellRow[],
  fresh: readonly NumbersSnapshotCellRow[],
  into: Map<string, MetricDiff>,
): number {
  const before = new Map(stored.map((r) => [cellId(r), r]));
  const after = new Map(fresh.map((r) => [cellId(r), r]));
  const bump = (metric: string, key: keyof MetricDiff) => {
    const d = into.get(metric) ?? { added: 0, removed: 0, changed: 0 };
    d[key] += 1;
    into.set(metric, d);
  };
  let total = 0;
  for (const [id, row] of after) {
    const old = before.get(id);
    if (old === undefined) {
      bump(row.metric, "added");
      total += 1;
    } else if (!sameCell(old, row)) {
      bump(row.metric, "changed");
      total += 1;
    }
  }
  for (const [id, row] of before) {
    if (!after.has(id)) {
      bump(row.metric, "removed");
      total += 1;
    }
  }
  return total;
}

export interface RecomputeNumbersSummary {
  readonly weeks: readonly string[];
  readonly perMetric: ReadonlyMap<string, MetricDiff>;
  readonly rowsChanged: number;
  readonly applied: boolean;
  /** The `numbers_recompute_log` row of an applied run; null for a dry run. */
  readonly logId: string | null;
}

export interface RecomputeNumbersDeps {
  readonly repo: Pick<
    NumbersWeeklyRepository,
    | "withTransaction"
    | "lockWeek"
    | "readWeek"
    | "replaceWeek"
    | "insertRecomputeLog"
    | "snapshotTablesExist"
    | "workerActivityTableExists"
  >;
  readonly snapshot: Pick<NumbersSnapshotService, "computeWeekRows" | "isDueToFreeze">;
  readonly log: (line: string) => void;
}

/** Thrown inside a dry run's transaction so it rolls back: a dry run leaves nothing behind. */
class DryRunRollback extends Error {}

/**
 * Recompute `args.fromWeek..args.toWeek` (see the module header). Prints the per-metric diff and
 * the total, and — applied — the log row's id. The reason is never printed.
 */
export async function recomputeNumbers(
  deps: RecomputeNumbersDeps,
  args: RecomputeNumbersArgs,
  now: Date = new Date(),
): Promise<RecomputeNumbersSummary> {
  const { repo, snapshot, log } = deps;
  if (!(await repo.snapshotTablesExist())) {
    throw new Error("numbers_weekly is missing: apply the numbers_weekly migration first");
  }
  const hasActivityTable = await repo.workerActivityTableExists();
  const weeks = weeksBetween(args.fromWeek, args.toWeek);
  const perMetric = new Map<string, MetricDiff>();
  let rowsChanged = 0;
  let logId: string | null = null;

  try {
    await repo.withTransaction(async (tx) => {
      for (const week of weeks) {
        // Applied, every writer of the week waits (the sweep included); a dry run takes no lock.
        if (args.apply) await repo.lockWeek(tx, week);
        const stored = await repo.readWeek(tx, week);
        const fresh = await snapshot.computeWeekRows(tx, week, hasActivityTable, now);
        rowsChanged += diffWeekRows(stored, fresh, perMetric);
        if (args.apply) {
          for (const cls of NUMBERS_FREEZE_CLASSES) {
            const frozenAt = snapshot.isDueToFreeze(week, now, cls) ? now : null;
            await repo.replaceWeek(tx, week, cls, rowsOfClass(fresh, cls), now, frozenAt);
          }
        }
      }
      if (!args.apply) throw new DryRunRollback();
      logId = await repo.insertRecomputeLog(tx, {
        actor: "cli",
        fromWeek: args.fromWeek,
        toWeek: args.toWeek,
        definitionVersion: NUMBERS_DEFINITION_VERSION,
        reason: args.reason,
        rowsChanged,
      });
    });
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  }

  const tag = `[${RECOMPUTE_NUMBERS_SCRIPT}]`;
  log(
    `${tag} ${args.apply ? "APPLIED" : "DRY RUN"} weeks=${args.fromWeek}..${args.toWeek} ` +
      `(${weeks.length}) definition_version=${NUMBERS_DEFINITION_VERSION}`,
  );
  for (const metric of [...perMetric.keys()].sort()) {
    const d = perMetric.get(metric)!;
    log(`${tag}   ${metric}: added=${d.added} removed=${d.removed} changed=${d.changed}`);
  }
  log(
    `${tag} ${args.apply ? "rows_changed" : "rows_would_change"}=${rowsChanged}` +
      (logId === null ? "" : ` log_id=${logId}`),
  );
  return { weeks, perMetric, rowsChanged, applied: args.apply, logId };
}
