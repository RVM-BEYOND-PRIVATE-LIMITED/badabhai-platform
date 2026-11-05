import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { can } from "../../../lib/auth/capabilities";
import { getAiAlertsStatus, describeSpendCap, describeTaskFallback } from "../../../lib/ai-alerts";
import { PageHeader } from "../../../components/page-header";
import { Stat } from "../../../components/stat";
import { StatusPill } from "../../../components/status-pill";
import { formatCount } from "../../../lib/format";
import { ACTION_ICON, Icon } from "@badabhai/icons";

export const dynamic = "force-dynamic";
export const metadata = { title: "AI alerts" };

/**
 * AI alerts (A10, #2580) — the LOUD-ALERTS list behind the banner (#2567).
 *
 * READ-ONLY on `read_entities` (the API's own guard): per-task fallback posture over the
 * echoed window, spend-cap trips, and the recent raised/cleared feed. A `0` with no
 * recorded calls is "silence, not an all-clear" — the copy says which, so a quiet window
 * during an outage cannot be read as health.
 */
export default async function AlertsPage() {
  const session = await requireCapability("read_entities");
  void can(session.capabilities, "read_entities");

  let status: Awaited<ReturnType<typeof getAiAlertsStatus>> | null = null;
  let failed = false;
  try {
    status = await getAiAlertsStatus();
  } catch {
    failed = true;
  }

  const breaching = (status?.tasks ?? []).filter((t) => t.active).length;
  const totalFallback = (status?.tasks ?? []).reduce((n, t) => n + t.fallback_calls, 0);

  return (
    <div className="page">
      <PageHeader
        title="AI alerts"
        description="Fallback posture and spend-cap trips while an alert is active."
        secondaryActions={
          <>
            <Link className="btn btn--ghost btn--sm" href="/funnel">
              <Icon name="funnel" />
              Onboarding funnel
            </Link>
            <Link className="btn btn--ghost btn--sm" href="/empty-feed">
              <Icon name="funnel-x" />
              Empty feed
            </Link>
          </>
        }
        info={
          <>
            <p>
              One read of <code className="code">GET /admin/ai-alerts</code> over the echoed
              trailing window. Thresholds come from server config; breaching means the fallback
              share crossed it on enough recorded calls.
            </p>
            <p>
              Silence is not an all-clear: a task with no recorded calls in the window reports zero,
              and a transport outage emits no cost row at all.
            </p>
          </>
        }
      />

      {failed || !status ? (
        <section className="panel">
          <div className="state state--error">
            <h3 className="state__title" id="alerts-error-heading">
              Alerts could not be loaded
            </h3>
            <p className="state__body">
              The alerts read failed, so this screen is MISSING rather than empty — do not read the
              absence of a banner elsewhere as an all-clear.
            </p>
            <div className="state__actions">
              <Link className="btn btn--ghost" href="/alerts">
                <Icon name={ACTION_ICON.retry} />
                Retry
              </Link>
            </div>
          </div>
        </section>
      ) : (
        <>
          <section aria-labelledby="alert-stats-heading">
            <h2 className="sr-only" id="alert-stats-heading">
              Key figures
            </h2>
            <div className="stats">
              <Stat
                label="Tasks breaching"
                value={formatCount(breaching)}
                tone={breaching > 0 ? "warn" : undefined}
                countUp={{ to: breaching, kind: "count" }}
              />
              <Stat
                label={`Fallback calls (last ${status.window_hours}h)`}
                value={formatCount(totalFallback)}
                countUp={{ to: totalFallback, kind: "count" }}
              />
              <Stat
                label={`Spend-cap trips (last ${status.window_hours}h)`}
                value={formatCount(status.spend_cap.breach_count)}
                tone={status.spend_cap.active ? "warn" : undefined}
                countUp={{ to: status.spend_cap.breach_count, kind: "count" }}
              />
            </div>
          </section>

          <section className="panel" aria-labelledby="tasks-heading">
            <div className="panel__head">
              <h2 className="panel__title" id="tasks-heading">
                Fallback by task
              </h2>
              <p className="panel__sub">
                Window: last {status.window_hours}h. Breach needs at least{" "}
                {status.thresholds.min_calls} recorded calls at{" "}
                {(status.thresholds.fallback_share * 100).toFixed(0)}% fallback.
              </p>
            </div>
            {status.tasks.length > 0 ? (
              <ul className="funnel">
                {status.tasks.map((t) => (
                  <li className="funnel__row" key={t.task_type}>
                    <span className="funnel__label">
                      <strong>{t.task_type}</strong>
                      <br />
                      <span className="funnel__events">{describeTaskFallback(t)}</span>
                    </span>
                    <span className="funnel__nums">
                      <StatusPill
                        value={t.active ? "breaching" : t.breaching ? "breaching" : "ok"}
                        label={t.active ? "Active" : t.breaching ? "Breaching" : "Within threshold"}
                        tone={t.active || t.breaching ? "warn" : "ok"}
                      />
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty">No task posture was returned for this window.</p>
            )}
          </section>

          <section className="panel" aria-labelledby="spend-heading">
            <div className="panel__head">
              <h2 className="panel__title" id="spend-heading">
                Spend cap
              </h2>
            </div>
            <p className="empty">{describeSpendCap(status.spend_cap)}</p>
          </section>

          <section className="panel" aria-labelledby="recent-heading">
            <div className="panel__head">
              <h2 className="panel__title" id="recent-heading">
                Recent alerts
              </h2>
              <p className="panel__sub">Raised and cleared verdicts, newest first.</p>
            </div>
            {status.recent_alerts.length > 0 ? (
              <ul className="funnel">
                {status.recent_alerts.map((r) => (
                  <li className="funnel__row" key={r.id}>
                    <span className="funnel__label">
                      <strong>{r.event_name}</strong>
                      <br />
                      <span className="funnel__events">
                        {[r.task_type, r.reason].filter(Boolean).join(" · ") ||
                          "no further detail recorded"}
                      </span>
                    </span>
                    <span className="funnel__nums">
                      <time
                        className="funnel__events"
                        dateTime={r.occurred_at}
                        title={r.occurred_at}
                      >
                        {new Date(r.occurred_at).toLocaleString()}
                      </time>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty">No raised or cleared verdicts in this window.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
