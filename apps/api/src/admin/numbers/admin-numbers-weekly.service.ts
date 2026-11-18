import { Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { sqlStateOf } from "../../common/db-error";
import { SERVER_CONFIG } from "../../config/config.module";
import type {
  AdminNumbersWeekly,
  AdminNumbersWeeklyChange,
  AdminNumbersWeeklyMetric,
  AdminNumbersWeeklyPoint,
  AdminNumbersWeeklyQueryDto,
} from "./admin-numbers.dto";
import {
  NUMBERS_COHORT_METRICS,
  NUMBERS_DEFINITION_VERSION,
  NUMBERS_METRIC_GROUPS,
  NUMBERS_REVENUE_PACK_PREFIX,
  NUMBERS_SNAPSHOT_METRICS,
  isRevenuePackMetricId,
  type NumbersMetricDefinition,
} from "./definitions";
import { isPendingCohortCell } from "./metrics/repeat-purchase";
import { NumbersWeeklyRepository, type NumbersStoredCellRow } from "./numbers-weekly.repository";
import { PG_UNDEFINED_TABLE } from "./numbers-snapshot.service";
import { numbersPaymentsPosture } from "./payments-posture";
import { previousWeek, weekStartOf, weeksBetween } from "./week";

/** A stored ratio or share is in hundredths; the wire carries the quotient (a share: 0..1). */
const HUNDREDTHS_SCALE = 100;

/** `this − last` and its percentage of `last` (one decimal); see {@link AdminNumbersWeeklyChange}. */
export function weekOnWeekChange(
  thisWeek: AdminNumbersWeeklyPoint | undefined,
  lastWeek: AdminNumbersWeeklyPoint | undefined,
  scale: number = 1,
): AdminNumbersWeeklyChange | null {
  if (thisWeek === undefined || lastWeek === undefined) return null;
  if (thisWeek.suppressed || lastWeek.suppressed) return null;
  if (thisWeek.value === null || lastWeek.value === null) return null;
  if (thisWeek.definition_version !== lastWeek.definition_version) return null;
  // In stored integer units (hundredths for a ratio), so the difference has no float drift.
  const now = Math.round(thisWeek.value * scale);
  const before = Math.round(lastWeek.value * scale);
  return {
    absolute: (now - before) / scale,
    percent: before === 0 ? null : Math.round(((now - before) * 1000) / before) / 10,
  };
}

/**
 * #2755 item 5 — `GET /admin/numbers/weekly`: every metric of the catalogue for one city group and
 * one trade group, with this week, last week, the change and the series.
 *
 * READS ONLY THE SNAPSHOT. Every figure comes from `numbers_weekly` (the filter's own stored cell,
 * never a sum of cells), and `before_real_payments` from its all-cities, all-trades
 * `paying_companies_cumulative`; no live table is read, so a frozen week cannot drift. A metric
 * the catalogue marks `not_available` has no stored row and is answered with its reason, never a
 * zero. Reached only through `AdminNumbersEnabledGuard` and `read_business_numbers`.
 *
 * FAIL CLOSED: the switch on before the snapshot's migration (42P01) is a 503, never an empty
 * screen that reads as "nothing happened".
 *
 * REPEAT BUYING (part C) is a COHORT figure stored under the week of the first payment: a point
 * whose window has not closed is `pending` (value null, the cohort size as its denominator), so
 * the newest weeks of a series are always pending. Each cohort metric therefore also carries
 * `latest_complete`: its newest CLOSED cohort for the filter, from any week up to this one. The call
 * list (group 10) is a LIST served by its own route: it is answered with its `list_route` and no
 * values, never as a zero.
 */
@Injectable()
export class AdminNumbersWeeklyService {
  private readonly logger = new Logger(AdminNumbersWeeklyService.name);

  constructor(
    private readonly repo: NumbersWeeklyRepository,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  async weekly(
    query: AdminNumbersWeeklyQueryDto,
    now: Date = new Date(),
  ): Promise<AdminNumbersWeekly> {
    const current = weekStartOf(now);
    // One week more than the series, so the oldest shown week still has a "last week".
    let first = current;
    for (let i = 1; i < query.weeks; i += 1) first = previousWeek(first);
    const weeks = weeksBetween(first, current);
    const read = [previousWeek(first), ...weeks];

    let cells: NumbersStoredCellRow[];
    let firstPaidWeek: string | null;
    let latestComplete: NumbersStoredCellRow[];
    try {
      cells = await this.repo.readCells(read, query.city, query.trade);
      firstPaidWeek = await this.repo.firstPaidWeek();
      latestComplete = await this.repo.readLatestCompleteCohorts(current, query.city, query.trade);
    } catch (err) {
      if (sqlStateOf(err) !== PG_UNDEFINED_TABLE) throw err;
      this.logger.warn(`numbers weekly read unavailable (sqlstate=${PG_UNDEFINED_TABLE})`);
      throw new ServiceUnavailableException("the numbers screen's snapshot is not applied yet");
    }

    const byMetric = new Map<string, Map<string, NumbersStoredCellRow>>();
    /** Any row of a week marks it computed (every computed week stores every live metric). */
    const weekRow = new Map<string, NumbersStoredCellRow>();
    let computedAt: Date | null = null;
    for (const c of cells) {
      if (!byMetric.has(c.metric)) byMetric.set(c.metric, new Map());
      byMetric.get(c.metric)!.set(c.weekStart, c);
      if (!weekRow.has(c.weekStart)) weekRow.set(c.weekStart, c);
      if (computedAt === null || c.computedAt.getTime() > computedAt.getTime()) {
        computedAt = c.computedAt;
      }
    }
    const beforeRealPayments = (week: string) => firstPaidWeek === null || week < firstPaidWeek;
    const latestByMetric = new Map(latestComplete.map((c) => [c.metric, c]));
    const packIds = [...byMetric.keys()].filter(isRevenuePackMetricId).sort();

    const metrics: AdminNumbersWeeklyMetric[] = [];
    for (const group of NUMBERS_METRIC_GROUPS) {
      for (const def of group.metrics) {
        const entry = this.metric(
          group.id,
          def,
          def.id,
          read,
          byMetric,
          weekRow,
          beforeRealPayments,
        );
        if (NUMBERS_COHORT_METRICS.includes(def.id) && entry.availability === "live") {
          const latest = latestByMetric.get(def.id);
          entry.latest_complete =
            latest === undefined
              ? null
              : this.point(def, latest.weekStart, latest, latest, beforeRealPayments);
        }
        metrics.push(entry);
        if (def.id === "revenue_by_pack" && def.availability.status === "live") {
          for (const id of packIds) {
            metrics.push({
              ...this.metric(group.id, def, id, read, byMetric, weekRow, beforeRealPayments),
              pack: id.slice(NUMBERS_REVENUE_PACK_PREFIX.length),
            });
          }
        }
      }
    }

    return {
      definition_version: NUMBERS_DEFINITION_VERSION,
      payments_posture: numbersPaymentsPosture(this.config),
      city: query.city,
      trade: query.trade,
      weeks,
      computed_at: computedAt === null ? null : (computedAt as Date).toISOString(),
      metrics,
    };
  }

  /** One metric's entry: its series over `read` (the first week only feeds "last week"). */
  private metric(
    group: string,
    def: NumbersMetricDefinition,
    id: string,
    read: readonly string[],
    byMetric: ReadonlyMap<string, ReadonlyMap<string, NumbersStoredCellRow>>,
    weekRow: ReadonlyMap<string, NumbersStoredCellRow>,
    beforeRealPayments: (week: string) => boolean,
  ): AdminNumbersWeeklyMetric {
    const base = {
      id,
      group,
      title: def.title,
      unit: def.unit,
      kind: def.kind,
    };
    if (def.availability.status === "live" && def.list_route !== undefined) {
      // A LIST (the call list): served by its own route, never a weekly number or a zero.
      return {
        ...base,
        availability: "live",
        list_route: def.list_route,
        this_week: null,
        last_week: null,
        change: null,
        series: [],
      };
    }
    const stored = def.availability.status === "live" && def.id in NUMBERS_SNAPSHOT_METRICS;
    if (!stored) {
      const reason =
        def.availability.status === "not_available"
          ? def.availability.reason
          : "the weekly snapshot does not hold this figure yet";
      return {
        ...base,
        availability: "not_available",
        reason,
        ...(def.availability.status === "not_available"
          ? { waits_on: def.availability.waits_on }
          : {}),
        this_week: null,
        last_week: null,
        change: null,
        series: [],
      };
    }

    const scale = scaleOf(def);
    const rows = byMetric.get(id);
    const points = read.map(
      (week): AdminNumbersWeeklyPoint =>
        this.point(def, week, rows?.get(week), weekRow.get(week), beforeRealPayments, id),
    );
    const series = points.slice(1);
    const thisWeek = series[series.length - 1];
    const lastWeek = points[points.length - 2];
    return {
      ...base,
      availability: "live",
      this_week: thisWeek?.value ?? null,
      last_week: lastWeek?.value ?? null,
      change: weekOnWeekChange(thisWeek, lastWeek, scale),
      series,
    };
  }

  /**
   * One week of one metric as the wire carries it: the stored `row` (absent when the week holds
   * none for this metric), read with `anyRow` (any row of the week: present when it is computed).
   */
  private point(
    def: NumbersMetricDefinition,
    week: string,
    row: NumbersStoredCellRow | undefined,
    anyRow: NumbersStoredCellRow | undefined,
    beforeRealPayments: (week: string) => boolean,
    id: string = def.id,
  ): AdminNumbersWeeklyPoint {
    const cohort = NUMBERS_COHORT_METRICS.includes(def.id);
    if (row === undefined) {
      // A computed week with no row for a pack: that pack sold nothing by then (a real zero is
      // stored once it has sold), or the week is not computed at all (null, nothing known).
      const packZero = anyRow !== undefined && isRevenuePackMetricId(id);
      return {
        week_start: week,
        value: packZero ? 0 : null,
        numerator: null,
        denominator: null,
        suppressed: false,
        pending: false,
        before_real_payments: beforeRealPayments(week),
        frozen: anyRow?.frozenAt != null,
        definition_version: anyRow?.definitionVersion ?? null,
      };
    }
    return {
      week_start: week,
      value: row.value === null ? null : row.value / scaleOf(def),
      numerator: row.numerator,
      denominator: row.denominator,
      suppressed: row.suppressed,
      pending: cohort && isPendingCohortCell(row),
      before_real_payments: beforeRealPayments(week),
      frozen: row.frozenAt !== null,
      definition_version: row.definitionVersion,
    };
  }
}

/** How a stored value maps to the wire: ratios and shares are stored in hundredths. */
function scaleOf(def: NumbersMetricDefinition): number {
  return def.unit === "ratio" || def.unit === "share" ? HUNDREDTHS_SCALE : 1;
}
