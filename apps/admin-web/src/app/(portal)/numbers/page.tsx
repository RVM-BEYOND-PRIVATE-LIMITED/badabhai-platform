import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import {
  getNumbersDefinitions,
  getWeeklyNumbers,
  type NumbersDefinitions,
  type NumbersWeeklyMetric,
  type WeeklyNumbers,
} from "../../../lib/numbers";
import {
  isAdminRequestError,
  isAdminUnauthorized,
} from "../../../lib/admin-http";
import { isUnknownValue, readRefusal, type ReadRefusal } from "../../../lib/read-refusal";
import { formatCount, packCodeLabel, timestampTitle } from "../../../lib/format";
import {
  formatMetricChange,
  formatMetricValue,
  formatPercent,
  describePoint,
} from "../../../lib/numbers-format";
import {
  NUMBERS_CITY_GROUPS,
  NUMBERS_CITY_LABELS,
  NUMBERS_TRADE_GROUPS,
  NUMBERS_TRADE_LABELS,
} from "../../../lib/numbers-vocabulary";
import { PageHeader } from "../../../components/page-header";
import { DataGrid, type GridColumn } from "../../../components/data-grid";
import { PanelSection } from "../../../components/panel-section";
import { DetailList } from "../../../components/detail-list";
import { PaymentsPostureBanner, MockMoneyTag } from "../../../components/payments-posture";
import { StatusPill } from "../../../components/status-pill";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { NumbersFilterBar } from "./numbers-filter-bar";
import { NumbersSparkline } from "./numbers-sparkline";
import { NumbersTabs } from "./numbers-tabs";

export const dynamic = "force-dynamic";
export const metadata = { title: "Numbers" };

type ReadProblem = "off" | "unavailable" | "filters" | "error";

/**
 * Weekly numbers (#2884; API #2755 parts A and B).
 *
 * The figures are the `numbers_weekly` snapshot's own cells, never a live table read, so a frozen
 * week cannot drift while it is on screen. Money is marked with the payments posture, a suppressed
 * worker cell says "fewer than 5", and a metric with no source says "Not available yet" with the
 * issue it waits on — never 0.
 */
export default async function NumbersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCapability("read_business_numbers");

  const sp = await searchParams;
  const one = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value[0] : value)?.trim() || undefined;

  const city = one(sp.city) ?? "all";
  const trade = one(sp.trade) ?? "all";
  const weeks = one(sp.weeks) ?? "12";
  const weeksNumber = Number(weeks);
  const weeksInvalid = !Number.isInteger(weeksNumber) || weeksNumber < 1 || weeksNumber > 26;
  const filtered =
    isUnknownValue(city, NUMBERS_CITY_GROUPS) ||
    isUnknownValue(trade, NUMBERS_TRADE_GROUPS) ||
    weeksInvalid;

  const [weeklyRes, definitionsRes] = await Promise.allSettled([
    getWeeklyNumbers({ city, trade, weeks }),
    getNumbersDefinitions(),
  ]);

  if (weeklyRes.status === "rejected" && isAdminUnauthorized(weeklyRes.reason)) {
    throw weeklyRes.reason;
  }

  const weekly = weeklyRes.status === "fulfilled" ? weeklyRes.value : null;
  const definitions = definitionsRes.status === "fulfilled" ? definitionsRes.value : null;
  const problem: ReadProblem | null =
    weeklyRes.status === "rejected"
      ? requestProblem(weeklyRes.reason, filtered, Boolean(one(sp.cursor)))
      : null;
  const definitionsProblem: ReadProblem | null =
    definitionsRes.status === "rejected"
      ? requestProblem(definitionsRes.reason, false, false)
      : null;
  const refusal: ReadRefusal =
    weeklyRes.status === "rejected"
      ? readRefusal(weeklyRes.reason, { filtered, cursor: undefined })
      : null;

  const retryHref = queryHref({ city, trade, weeks });
  const posture = weekly?.payments_posture ?? definitions?.payments ?? null;

  const groupTitles = new Map(
    (definitions?.metric_groups ?? []).map((group) => [group.id, group.title]),
  );

  return (
    <div className="page">
      <PageHeader
        title="Numbers"
        description="The company's weekly business figures, as the nightly snapshot counted them."
        info={
          <>
            <p>
              Every figure is the filtered cell's own stored value. A roll-up is counted from the
              source rows, never by adding suppressed cells together.
            </p>
            <p>
              The current week is always in progress. A week that ends before the first real
              payment is marked in the chart.
            </p>
          </>
        }
        filters={
          <>
            <NumbersTabs active="weekly" />
            <NumbersFilterBar city={city} trade={trade} weeks={weeks} />
          </>
        }
      />

      {posture && <PaymentsPostureBanner posture={posture} />}

      {problem ? (
        <ReadProblemPanel problem={problem} retryHref={retryHref} refusal={refusal} />
      ) : weekly ? (
        <>
          <section className="panel" aria-labelledby="numbers-headline">
            <div className="panel__head panel__head--row">
              <div>
                <h2 className="panel__title" id="numbers-headline">
                  Headline numbers
                </h2>
                <p className="panel__sub">
                  {NUMBERS_CITY_LABELS[city as keyof typeof NUMBERS_CITY_LABELS] ?? city} ·{" "}
                  {NUMBERS_TRADE_LABELS[trade as keyof typeof NUMBERS_TRADE_LABELS] ?? trade} · the
                  last {weeks} week{weeksNumber === 1 ? "" : "s"}.
                  {weekly.computed_at ? (
                    <>
                      {" "}
                      Computed{" "}
                      <time dateTime={weekly.computed_at} title={timestampTitle(weekly.computed_at)}>
                        {timestampTitle(weekly.computed_at).split(" · ")[0]}
                      </time>
                      .
                    </>
                  ) : null}
                </p>
              </div>
            </div>
            <MetricGroups
              metrics={weekly.metrics.filter((metric) => metric.kind !== "diagnostic")}
              groupTitles={groupTitles}
              posture={weekly.payments_posture}
            />
          </section>

          <section className="panel" aria-labelledby="numbers-diagnostics">
            <div className="panel__head">
              <h2 className="panel__title" id="numbers-diagnostics">
                Diagnostics
              </h2>
              <p className="panel__sub">
                The known gaps behind a headline figure. They are not headline numbers.
              </p>
            </div>
            <MetricGroups
              metrics={weekly.metrics.filter((metric) => metric.kind === "diagnostic")}
              groupTitles={groupTitles}
              posture={weekly.payments_posture}
            />
          </section>
        </>
      ) : null}

      {problem === "off" || problem === "unavailable" ? null : (
        <AboutNumbers definitions={definitions} problem={definitionsProblem} />
      )}
    </div>
  );
}

function requestProblem(err: unknown, filtered: boolean, hasCursor: boolean): ReadProblem {
  if (isAdminRequestError(err)) {
    if (err.status === 404) return "off";
    if (err.status === 503) return "unavailable";
    if (err.status === 400 && (filtered || hasCursor)) return "filters";
  }
  return "error";
}

function ReadProblemPanel({
  problem,
  retryHref,
  refusal,
}: {
  problem: ReadProblem;
  retryHref: string;
  refusal: ReadRefusal;
}) {
  if (problem === "off") {
    return (
      <section className="panel" aria-labelledby="numbers-off">
        <div className="panel__head">
          <h2 className="panel__title" id="numbers-off">
            Not switched on yet
          </h2>
        </div>
        <div className="state">
          <h3 className="state__title">The numbers screen is switched off</h3>
          <p className="state__body">
            This deployment has not turned the numbers screen on. Nothing is wrong with your
            access, and no figure was read.
          </p>
        </div>
      </section>
    );
  }
  if (problem === "unavailable") {
    return (
      <section className="panel" aria-labelledby="numbers-unavailable">
        <div className="panel__head">
          <h2 className="panel__title" id="numbers-unavailable">
            Try again later
          </h2>
        </div>
        <div className="state state--error">
          <h3 className="state__title">The numbers tables are not ready yet</h3>
          <p className="state__body">
            A migration this screen reads has not been applied, so nothing was fetched. This is
            not an empty week — it is a missing table.
          </p>
        </div>
      </section>
    );
  }
  if (problem === "filters") {
    return (
      <section className="panel" aria-labelledby="numbers-filter-error">
        <div className="panel__head">
          <h2 className="panel__title" id="numbers-filter-error">
            The server rejected that filter
          </h2>
        </div>
        <div className="state state--error">
          <h3 className="state__title">
            {refusal === "filters" ? "One of the filter values is not known" : "The page cursor was refused"}
          </h3>
          <p className="state__body">
            Nothing was fetched. City, trade and weeks are closed values; use the filters above or
            clear them.
          </p>
          <div className="state__actions">
            <Link className="btn btn--ghost" href="/numbers">
              <Icon name={ACTION_ICON.clearFilters} />
              Clear filters
            </Link>
          </div>
        </div>
      </section>
    );
  }
  return (
    <section className="panel" aria-labelledby="numbers-error">
      <div className="panel__head">
        <h2 className="panel__title" id="numbers-error">
          The weekly numbers are unavailable
        </h2>
      </div>
      <div className="state state--error">
        <h3 className="state__title">The figures did not load</h3>
        <p className="state__body">
          This is a fault on our side rather than anything in the filters. Retry reads the same
          week again.
        </p>
        <div className="state__actions">
          <Link className="btn btn--ghost" href={retryHref}>
            <Icon name={ACTION_ICON.retry} />
            Retry
          </Link>
        </div>
      </div>
    </section>
  );
}

function MetricGroups({
  metrics,
  groupTitles,
  posture,
}: {
  metrics: readonly NumbersWeeklyMetric[];
  groupTitles: Map<string, string>;
  posture: NonNullable<WeeklyNumbers["payments_posture"]>;
}) {
  if (metrics.length === 0) {
    return (
      <div className="state">
        <h3 className="state__title">No metrics here yet</h3>
        <p className="state__body">
          The catalogue has no figure of this kind for the selected filter.
        </p>
      </div>
    );
  }

  const groups: { id: string; title: string; metrics: NumbersWeeklyMetric[] }[] = [];
  for (const metric of metrics) {
    const last = groups.at(-1);
    if (last && last.id === metric.group) last.metrics.push(metric);
    else
      groups.push({
        id: metric.group,
        title: groupTitles.get(metric.group) ?? metric.group.replace(/_/g, " "),
        metrics: [metric],
      });
  }

  return (
    <>
      {groups.map((group) => (
        <PanelSection key={group.id} title={group.title} titleId={`numbers-group-${group.id}`}>
          <DataGrid
            id={`numbers-${group.id}`}
            caption={group.title}
            columns={METRIC_COLUMNS(posture)}
            rows={group.metrics}
            rowKey={(metric) => metric.id}
            viewControls={false}
          />
        </PanelSection>
      ))}
    </>
  );
}

function METRIC_COLUMNS(
  posture: NonNullable<WeeklyNumbers["payments_posture"]>,
): readonly GridColumn<NumbersWeeklyMetric>[] {
  const money = (metric: NumbersWeeklyMetric) => metric.unit === "paise";

  return [
    {
      id: "metric",
      header: "Metric",
      text: "wrap",
      rowHeader: true,
      cell: (metric) => (
        <span>
          {metric.title}
          {metric.pack ? ` · ${packCodeLabel(metric.pack)}` : ""}
          {metric.availability === "not_available" ? (
            <span className="table__meta">
              {" "}
              — Not available yet{metric.reason ? `: ${metric.reason}` : ""}
              {metric.waits_on ? ` (waits on ${metric.waits_on})` : ""}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "this-week",
      header: "This week",
      width: "number",
      className: "ui-num",
      cell: (metric) => <ThisWeekCell metric={metric} posture={posture} />,
    },
    {
      id: "last-week",
      header: "Last week",
      width: "number",
      className: "ui-num",
      cell: (metric) => (
        <ValueCell metric={metric} value={metric.last_week} pointIndex="last" posture={posture} />
      ),
    },
    {
      id: "change",
      header: "Change",
      width: "short",
      className: "ui-num",
      cell: (metric) => {
        if (metric.availability === "not_available") return <span className="table__meta">—</span>;
        if (!metric.change) return <span className="table__meta">—</span>;
        return (
          <span title={`absolute and percent, in ${metric.unit}`}>
            {formatMetricChange(metric.change.absolute, metric.unit)}{" "}
            <span className="table__meta">({formatPercent(metric.change.percent)})</span>
            {money(metric) ? <MockMoneyTag posture={posture} /> : null}
          </span>
        );
      },
    },
    {
      id: "series",
      header: "Series",
      width: "fill",
      cell: (metric) =>
        metric.series.length > 0 ? (
          <NumbersSparkline points={metric.series} unit={metric.unit} label={metric.title} />
        ) : (
          <span className="table__meta">No series yet</span>
        ),
    },
  ];
}

function ThisWeekCell({
  metric,
  posture,
}: {
  metric: NumbersWeeklyMetric;
  posture: NonNullable<WeeklyNumbers["payments_posture"]>;
}) {
  if (metric.availability === "not_available") {
    return <span className="table__meta">Not available yet</span>;
  }
  if (metric.latest_complete !== undefined && metric.latest_complete !== null) {
    return (
      <span title="The newest cohort whose window has fully closed.">
        {describePoint(metric.latest_complete, metric.unit)}
        {metric.unit === "paise" ? <MockMoneyTag posture={posture} /> : null}{" "}
        <span className="table__meta">latest complete cohort</span>
      </span>
    );
  }
  if (metric.latest_complete === null) {
    return <span className="table__meta">No complete cohort yet</span>;
  }
  return (
    <span title="The current week is still running; this figure is partial.">
      <ValueCell metric={metric} value={metric.this_week} pointIndex="current" posture={posture} />
      {metric.kind === "headline" && metric.availability === "live" ? (
        <span className="pill pill--warn">partial</span>
      ) : null}
    </span>
  );
}

function ValueCell({
  metric,
  value,
  pointIndex,
  posture,
}: {
  metric: NumbersWeeklyMetric;
  value: number | null;
  pointIndex: "current" | "last";
  posture: NonNullable<WeeklyNumbers["payments_posture"]>;
}) {
  if (metric.availability === "not_available") {
    return <span className="table__meta">Not available yet</span>;
  }
  const point =
    pointIndex === "current" ? metric.series.at(-1) : metric.series.at(-2);
  if (point?.suppressed) {
    return (
      <span title={`Fewer than 5 distinct subjects — withheld to protect individuals.`}>
        fewer than 5
      </span>
    );
  }
  if (point?.pending) return <span className="table__meta">Window not closed</span>;
  if (value === null) {
    return (
      <span className="table__meta">
        {point && point.definition_version === null ? "Not computed" : "—"}
      </span>
    );
  }
  return (
    <span>
      {formatMetricValue(value, metric.unit)}
      {metric.unit === "paise" ? <MockMoneyTag posture={posture} /> : null}
    </span>
  );
}

function AboutNumbers({
  definitions,
  problem,
}: {
  definitions: NumbersDefinitions | null;
  problem: ReadProblem | null;
}) {
  if (problem || !definitions) {
    return (
      <section className="panel" aria-labelledby="numbers-about-error">
        <div className="panel__head">
          <h2 className="panel__title" id="numbers-about-error">
            About these numbers
          </h2>
        </div>
        {problem === "off" ? (
          <div className="state">
            <h3 className="state__title">Not switched on yet</h3>
            <p className="state__body">
              This deployment has not turned the numbers screen on, so the definitions are not
              available either.
            </p>
          </div>
        ) : problem === "unavailable" ? (
          <div className="state state--error">
            <h3 className="state__title">Try again later</h3>
            <p className="state__body">
              The definitions table is not ready yet, so this panel could not be read.
            </p>
          </div>
        ) : (
          <div className="state state--error">
            <h3 className="state__title">The definitions could not be loaded</h3>
            <p className="state__body">
              The figures above are unaffected. This panel explains how they are counted, and
              that read failed.
            </p>
            <div className="state__actions">
              <Link className="btn btn--ghost" href="/numbers">
                <Icon name={ACTION_ICON.retry} />
                Retry
              </Link>
            </div>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="panel" aria-labelledby="numbers-about">
      <div className="panel__head">
        <h2 className="panel__title" id="numbers-about">
          About these numbers
        </h2>
        <p className="panel__sub">
          Version {definitions.definition_version}. Every figure on this screen is counted under
          these rules.
        </p>
      </div>

      <PanelSection title="The week" titleId="numbers-about-week">
        <DetailList
          items={[
            { label: "Rule", value: definitions.week.rule },
            { label: "Time zone", value: `${definitions.week.time_zone} (${definitions.week.utc_offset})` },
            { label: "Starts on", value: definitions.week.starts_on },
            { label: "Small cell floor", value: `${formatCount(definitions.small_cell_floor)} workers` },
          ]}
        />
      </PanelSection>

      <PanelSection title="Who is left out" titleId="numbers-about-exclusions">
        <DetailList
          items={[
            { label: "Companies", value: definitions.exclusions.companies },
            { label: "Workers", value: definitions.exclusions.workers },
          ]}
        />
      </PanelSection>

      <PanelSection title="City groups" titleId="numbers-about-cities">
        <p className="panel__sub">{definitions.cities.buckets}</p>
        <p className="panel__sub">{definitions.cities.normalisation}</p>
        <ul className="chips">
          {definitions.cities.groups.map((group) => (
            <li className="chip" key={group.id}>
              <strong>{group.title}</strong>
              {group.members.length > 0 ? ` · ${group.members.join(", ")}` : null}
            </li>
          ))}
        </ul>
      </PanelSection>

      <PanelSection title="Trade groups" titleId="numbers-about-trades">
        <p className="panel__sub">{definitions.trades.buckets}</p>
        <ul className="chips">
          {definitions.trades.groups.map((group) => (
            <li className="chip" key={group.id}>
              <strong>{group.title}</strong>
              {group.role_kinds.length + group.taxonomy_roles.length > 0
                ? ` · ${[...group.role_kinds, ...group.taxonomy_roles].join(", ")}`
                : null}
            </li>
          ))}
        </ul>
      </PanelSection>

      <PanelSection title="What each figure means" titleId="numbers-about-metrics">
        {definitions.metric_groups.map((group) => (
          <div className="panel__section" key={group.id}>
            <h4 className="panel__section-title">
              {group.number}. {group.title}
            </h4>
            <ul className="list">
              {group.metrics.map((metric) => (
                <li key={metric.id}>
                  <strong>{metric.title}</strong>{" "}
                  <StatusPill
                    value={metric.availability.status}
                    label={metric.availability.status === "live" ? "Live" : "Not available"}
                    tone={metric.availability.status === "live" ? "ok" : "warn"}
                  />{" "}
                  <span className="table__meta">{metric.unit}</span>
                  <p className="panel__sub">{metric.source}</p>
                  <p className="panel__sub">{metric.rule}</p>
                  {metric.availability.status === "not_available" ? (
                    <p className="field__help">
                      Not available yet: {metric.availability.reason} (waits on{" "}
                      {metric.availability.waits_on}).
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </PanelSection>
    </section>
  );
}

function queryHref({ city, trade, weeks }: { city: string; trade: string; weeks: string }): string {
  const q = new URLSearchParams();
  if (city !== "all") q.set("city", city);
  if (trade !== "all") q.set("trade", trade);
  if (weeks !== "12") q.set("weeks", weeks);
  const s = q.toString();
  return s ? `/numbers?${s}` : "/numbers";
}
