import Link from "next/link";
import { requireSession } from "../../lib/auth";
import { ROLE_LABELS, can } from "../../lib/auth/capabilities";
import { getHealth, getMetrics, listEvents } from "../../lib/events";
import { getDashboardSummary } from "../../lib/dashboard";
import { EventTable } from "../../components/event-table";
import { AiSpendPanel } from "../../components/ai-spend-panel";
import { VolumePanel } from "../../components/volume-panel";
import { Stat } from "../../components/stat";
import { buildAdminAttention } from "./attention";
import {
  formatCount,
  formatSuppressible,
  healthTone,
  humanizeEventName,
} from "../../lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard" };

/**
 * Dashboard — live, on the events spine.
 *
 * Every number here comes from `GET /admin/events/metrics` or `/admin/events`. There are
 * no placeholder tiles: an invented figure on an operations console is indistinguishable
 * from a real one, and once an operator learns a tile can lie they stop trusting the ones
 * beside it.
 *
 * Metrics, health and the recent feed are fetched CONCURRENTLY — they are independent
 * reads, and serialising them would make the slowest one the page's latency floor.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const mayReadEvents = can(session.capabilities, "read_events");
  // The AI-spend and volume blocks are `GET /admin/dashboard/summary`, which the API declares
  // under `read_entities` (live system-of-record state + money, not the event spine). Gated
  // in-page rather than at the route, so an operator without it sees a coherent dashboard
  // instead of a redirect — the rule `requireCapability`'s own doc states.
  const mayReadEntities = can(session.capabilities, "read_entities");

  /**
   * `requireCapability()` bounces an operator here with `?denied=<capability>` (see
   * lib/auth/session.ts). Nothing read that parameter, so the redirect was silent: you
   * clicked "Admin users", the URL flickered, and you were on the dashboard with no idea
   * whether the click had missed, the page was broken, or you simply were not allowed.
   * Saying so plainly is the difference between a permission boundary and a bug.
   */
  const deniedParam = (await searchParams).denied;
  const denied = Array.isArray(deniedParam) ? deniedParam[0] : deniedParam;

  // `allSettled`, not `all`: health is a different service from the events API, and one
  // being down must not blank the whole dashboard. Each region renders its own failure.
  const [metricsRes, healthRes, recentRes, summaryRes] = await Promise.allSettled([
    mayReadEvents ? getMetrics() : Promise.reject(new Error("no capability")),
    getHealth(),
    mayReadEvents ? listEvents({ limit: 8 }) : Promise.reject(new Error("no capability")),
    mayReadEntities ? getDashboardSummary() : Promise.reject(new Error("no capability")),
  ]);

  const metrics = metricsRes.status === "fulfilled" ? metricsRes.value : null;
  const health = healthRes.status === "fulfilled" ? healthRes.value : null;
  const recent = recentRes.status === "fulfilled" ? recentRes.value : null;
  const summary = summaryRes.status === "fulfilled" ? summaryRes.value : null;

  const totalEvents = metrics?.by_event_name.reduce((sum, b) => sum + b.count, 0) ?? 0;
  const breachTotal = metrics?.breaches.reduce((sum, b) => sum + b.count, 0) ?? 0;

  // The console's first question is "is anything wrong?", not "how much happened?".
  const attention = buildAdminAttention({
    metrics,
    health,
    mayReadEvents,
    metricsFailed: mayReadEvents && metricsRes.status === "rejected",
    recentFailed: mayReadEvents && recentRes.status === "rejected",
  });

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Dashboard</h1>
          <p className="page__sub">
            {/* TWO DIFFERENT PERIODS ON ONE SCREEN, said out loud. The event aggregates are
                windowed; AI spend accrues from migration 0077 and volume is live table
                state. One "over the last N days" caption over all of them would be wrong
                about two thirds of the page. */}
            Event activity over the last {metrics?.window_days ?? "—"} days. AI spend and
            volume below carry their own periods.
          </p>
        </div>
      </header>

      {denied ? (
        <p className="notice notice--warn" role="status">
          You do not have the <code className="code">{denied}</code> capability, so that
          section is not available to your role ({ROLE_LABELS[session.role]}). Ask an
          administrator if you need it.
        </p>
      ) : null}

      {/* NEEDS ATTENTION — rendered only when something genuinely does, so its presence is
          itself information. See attention.ts for why each item is here. */}
      {attention.length > 0 ? (
        <section className="attention" aria-labelledby="attention-heading">
          <h2 className="attention__heading" id="attention-heading">
            Needs attention
          </h2>
          <ul className="attention__list">
            {attention.map((item) => (
              <li className={`attention__item attention__item--${item.tone}`} key={item.id}>
                <div className="attention__text">
                  <p className="attention__title">{item.title}</p>
                  <p className="attention__body">{item.body}</p>
                </div>
                {item.href ? (
                  <Link className="btn btn--ghost btn--sm attention__action" href={item.href}>
                    {item.linkLabel}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ---- headline counters ------------------------------------------- */}
      {mayReadEvents && (
        <section aria-labelledby="stats-heading">
          <h2 className="sr-only" id="stats-heading">
            Key figures
          </h2>
          {metrics ? (
            <div className="stats">
              <Stat label="Events recorded" value={formatCount(totalEvents)} />
              <Stat label="Distinct event types" value={formatCount(metrics.by_event_name.length)} />
              <Stat
                label="Cap breaches"
                value={formatCount(breachTotal)}
                tone={breachTotal > 0 ? "warn" : undefined}
              />
              <Stat label="Window" value={`${metrics.window_days} days`} />
            </div>
          ) : (
            <p className="empty">Metrics are unavailable right now.</p>
          )}
        </section>
      )}

      <div className="cols">
        {/* ---- funnel --------------------------------------------------- */}
        {mayReadEvents && (
          <section className="panel" aria-labelledby="funnel-heading">
            <div className="panel__head">
              <h2 className="panel__title" id="funnel-heading">
                Conversion funnel
              </h2>
              <p className="panel__sub">
                Distinct subjects per stage. Counts below the k-anonymity floor are
                withheld rather than shown as zero.
              </p>
            </div>

            {metrics && metrics.funnel.length > 0 ? (
              <ul className="funnel">
                {metrics.funnel.map((stage) => {
                  const d = formatSuppressible(
                    stage.distinct_subjects,
                    stage.suppressed,
                    metrics.k_anon_floor,
                  );
                  return (
                    <li className="funnel__row" key={stage.event_name}>
                      <span className="funnel__label">{humanizeEventName(stage.event_name)}</span>
                      <span className="funnel__nums">
                        <span
                          className={`funnel__distinct${d.isSuppressed ? " is-suppressed" : ""}`}
                          title={d.hint}
                        >
                          {d.text}
                        </span>
                        <span className="funnel__events">{formatCount(stage.count)} events</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="empty">No funnel activity in this window.</p>
            )}
          </section>
        )}

        {/* ---- system health -------------------------------------------- */}
        <section className="panel" aria-labelledby="health-heading">
          <div className="panel__head">
            <h2 className="panel__title" id="health-heading">
              System health
            </h2>
            <p className="panel__sub">Live from the API health probe.</p>
          </div>

          {health ? (
            <>
              <ul className="health">
                {Object.entries(health.checks).map(([name, value]) => {
                  const tone = healthTone(value);
                  return (
                    <li className="health__row" key={name}>
                      <span className={`dot dot--${tone}`} aria-hidden="true" />
                      <span className="health__name">{name.replace(/_/g, " ")}</span>
                      <span className={`health__value health__value--${tone}`}>{value}</span>
                    </li>
                  );
                })}
              </ul>
              <p className="field__help">
                Environment <strong>{health.environment}</strong>. A check reading{" "}
                <code>mock</code> means that dependency is simulated — the platform is up,
                but that path is not exercising the real provider.
              </p>
            </>
          ) : (
            <p className="empty">The health probe is unreachable.</p>
          )}
        </section>
      </div>

      {/* ---- AI spend + volume ------------------------------------------
          `GET /admin/dashboard/summary`, one read behind both panels. Its own
          `allSettled` slot, so a failure here leaves the funnel, health and activity
          blocks intact — and says so, rather than rendering an empty section that reads
          as "the platform has spent nothing and has no users". */}
      {mayReadEntities ? (
        summary ? (
          <>
            <AiSpendPanel cost={summary.ai_cost} />
            <VolumePanel volume={summary.volume} />
          </>
        ) : (
          <section className="panel" aria-labelledby="summary-error-heading">
            <div className="state state--error">
              <h3 className="state__title" id="summary-error-heading">
                AI spend and volume could not be loaded
              </h3>
              <p className="state__body">
                The dashboard summary read failed, so those two sections are MISSING rather
                than empty — do not read their absence as zero spend or zero volume. The
                figures above come from separate reads and are unaffected. Reload to try
                again.
              </p>
            </div>
          </section>
        )
      ) : (
        <section className="panel">
          <p className="empty">
            AI spend and platform volume need the <code className="code">read_entities</code>{" "}
            capability, which your role ({ROLE_LABELS[session.role]}) does not have.
          </p>
        </section>
      )}

      {/* ---- recent activity -------------------------------------------- */}
      {mayReadEvents && (
        <section className="panel" aria-labelledby="recent-heading">
          <div className="panel__head panel__head--row">
            <div>
              <h2 className="panel__title" id="recent-heading">
                Recent activity
              </h2>
              <p className="panel__sub">The newest entries on the audit spine.</p>
            </div>
            <Link className="btn btn--ghost" href="/events">
              View all events
            </Link>
          </div>

          {recent ? (
            <EventTable
              events={recent.events}
              emptyMessage="No events recorded yet"
              /* This widget has NO filters, so it must not tell anyone to widen one; and the
                 panel head above already renders "View all events" to the same target, so an
                 action here would be a duplicate link with an identical accessible name
                 inside one panel. */
              emptyBody="The audit spine fills as the platform is used. Recent activity will appear here."
            />
          ) : (
            <p className="empty">The event feed is unavailable right now.</p>
          )}
        </section>
      )}

      {!mayReadEvents && (
        <section className="panel">
          <p className="empty">
            Your role does not include event access, so the activity views are hidden.
          </p>
        </section>
      )}
    </div>
  );
}
