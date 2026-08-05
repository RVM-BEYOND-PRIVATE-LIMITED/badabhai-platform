import Link from "next/link";
import { requireSession } from "../../lib/auth";
import { can } from "../../lib/auth/capabilities";
import { getHealth, getMetrics, listEvents } from "../../lib/events";
import { EventTable } from "../../components/event-table";
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
export default async function DashboardPage() {
  const session = await requireSession();
  const mayReadEvents = can(session.capabilities, "read_events");

  // `allSettled`, not `all`: health is a different service from the events API, and one
  // being down must not blank the whole dashboard. Each region renders its own failure.
  const [metricsRes, healthRes, recentRes] = await Promise.allSettled([
    mayReadEvents ? getMetrics() : Promise.reject(new Error("no capability")),
    getHealth(),
    mayReadEvents ? listEvents({ limit: 8 }) : Promise.reject(new Error("no capability")),
  ]);

  const metrics = metricsRes.status === "fulfilled" ? metricsRes.value : null;
  const health = healthRes.status === "fulfilled" ? healthRes.value : null;
  const recent = recentRes.status === "fulfilled" ? recentRes.value : null;

  const totalEvents = metrics?.by_event_name.reduce((sum, b) => sum + b.count, 0) ?? 0;
  const breachTotal = metrics?.breaches.reduce((sum, b) => sum + b.count, 0) ?? 0;

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Dashboard</h1>
          <p className="page__sub">
            Platform activity over the last {metrics?.window_days ?? "—"} days.
          </p>
        </div>
      </header>

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
            <EventTable events={recent.events} emptyMessage="No events recorded yet." />
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

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div className={`stat${tone ? ` stat--${tone}` : ""}`}>
      <span className="stat__value">{value}</span>
      <span className="stat__label">{label}</span>
    </div>
  );
}
