import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "../../../../lib/auth";
import { getJobPosting, listApplications } from "../../../../lib/entities";
import { isAdminRequestError } from "../../../../lib/admin-http";
import {
  formatCount,
  formatPayBand,
  formatRelative,
  formatTimestamp,
  shortId,
} from "../../../../lib/format";
import { StatusPill } from "../../../../components/status-pill";
import { DetailList } from "../../../../components/detail-list";

export const dynamic = "force-dynamic";
export const metadata = { title: "Job posting" };

/**
 * One job posting — the full poster-typed content plus its reach.
 *
 * The description is shown in full and verbatim, because reviewing a posting for spam or a
 * misleading claim is one of the main reasons an operator opens this page, and a truncated
 * or prettified version would be the wrong thing to judge. It is already worker-visible.
 */
export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireCapability("read_entities");
  const { id } = await params;

  let job: Awaited<ReturnType<typeof getJobPosting>>;
  try {
    job = await getJobPosting(id);
  } catch (err) {
    if (isAdminRequestError(err) && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }

  const decisions = await listApplications({ jobPostingId: id, limit: 10 }).catch(() => null);
  const total = job.applied_count + job.skipped_count;
  // Only meaningful once anyone has seen it; 0/0 would render NaN%.
  const applyRate = total > 0 ? Math.round((job.applied_count / total) * 100) : null;

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <p className="page__eyebrow">
            <Link className="link" href="/jobs">
              Jobs
            </Link>
          </p>
          <h1 className="page__title">{job.role_title}</h1>
          <p className="page__sub">
            Published as <strong>{job.org_label}</strong>
            {job.city || job.location_label ? ` · ${job.city ?? job.location_label}` : ""} ·
            created {formatRelative(job.created_at)}
          </p>
        </div>
        <div className="page__actions">
          {job.payer_id && (
            <Link className="btn btn--ghost" href={`/companies/${job.payer_id}`}>
              Owner account
            </Link>
          )}
          <Link
            className="btn btn--ghost"
            href={`/events?subjectType=job_posting&subjectId=${job.id}`}
          >
            Event timeline
          </Link>
        </div>
      </header>

      {job.status === "suspended" && (
        <section className="notice notice--bad" role="status">
          <strong>Hidden by a suspension.</strong> The owning account is suspended, so this
          posting is out of the worker feed. Reinstating the account restores it to{" "}
          <strong>{job.previous_status ?? "its previous state"}</strong> rather than forcing
          it open — a posting the payer had paused stays paused.
        </section>
      )}

      {job.verification_status === "unverified" && job.status === "open" && (
        <section className="notice notice--warn" role="status">
          <strong>Live but unreviewed.</strong> This posting is visible to workers and has
          not passed trust review, so it carries no verified badge.
        </section>
      )}

      <div className="cols">
        <section className="panel" aria-labelledby="j-content">
          <div className="panel__head">
            <h2 className="panel__title" id="j-content">
              Posting content
            </h2>
            <p className="panel__sub">Exactly what the poster wrote and workers see.</p>
          </div>
          <DetailList
            items={[
              { label: "Role title", value: job.role_title },
              { label: "Published as", value: job.org_label },
              { label: "Location", value: job.location_label ?? "not stated" },
              { label: "Match city", value: job.city ?? "not set" },
              { label: "Vacancies", value: job.vacancy_band },
              { label: "Monthly pay", value: formatPayBand(job.pay_min, job.pay_max) },
              { label: "Shift", value: job.shift ?? "not stated" },
              { label: "Needed by", value: job.needed_by ?? "not stated" },
            ]}
          />
          <div className="prose">
            <h3 className="prose__head">Description</h3>
            {job.description ? (
              // `white-space: pre-wrap` — the poster's line breaks are part of what is being
              // reviewed, and collapsing them changes how the ad reads.
              <p className="prose__body">{job.description}</p>
            ) : (
              <p className="empty">No description was provided.</p>
            )}
          </div>
        </section>

        <section className="panel" aria-labelledby="j-state">
          <div className="panel__head">
            <h2 className="panel__title" id="j-state">
              State and reach
            </h2>
            <p className="panel__sub">Lifecycle, trust review, and how workers responded.</p>
          </div>

          <div className="stats stats--compact">
            <div className="stat">
              <span className="stat__value">{formatCount(job.applied_count)}</span>
              <span className="stat__label">Applied</span>
            </div>
            <div className="stat">
              <span className="stat__value">{formatCount(job.skipped_count)}</span>
              <span className="stat__label">Skipped</span>
            </div>
            <div className="stat">
              <span className="stat__value">{applyRate === null ? "—" : `${applyRate}%`}</span>
              <span className="stat__label">
                {applyRate === null ? "Not seen yet" : "Apply rate"}
              </span>
            </div>
          </div>

          <DetailList
            items={[
              { label: "Status", value: <StatusPill value={job.status} /> },
              { label: "Trust review", value: <StatusPill value={job.verification_status} /> },
              {
                label: "Owner account",
                value: job.payer_id ? (
                  <Link className="link mono" href={`/companies/${job.payer_id}`}>
                    {shortId(job.payer_id)}
                  </Link>
                ) : (
                  "ops-created (no customer account)"
                ),
              },
              {
                label: "Published",
                value: job.published_at ? (
                  <time dateTime={job.published_at} title={formatTimestamp(job.published_at)}>
                    {formatRelative(job.published_at)}
                  </time>
                ) : (
                  "never published"
                ),
              },
              {
                label: "Boosted until",
                value: job.boosted_until ? (
                  <time dateTime={job.boosted_until} title={formatTimestamp(job.boosted_until)}>
                    {formatRelative(job.boosted_until)}
                  </time>
                ) : (
                  "not boosted"
                ),
              },
              {
                label: "Closed",
                value: job.closed_at ? (
                  <time dateTime={job.closed_at} title={formatTimestamp(job.closed_at)}>
                    {formatRelative(job.closed_at)}
                  </time>
                ) : (
                  "open-ended"
                ),
              },
              { label: "Posting id", value: <span className="mono">{job.id}</span> },
            ]}
          />
        </section>
      </div>

      <section className="panel" aria-labelledby="j-decisions">
        <div className="panel__head">
          <h2 className="panel__title" id="j-decisions">
            Recent worker decisions
          </h2>
          <p className="panel__sub">
            The ten most recent. Workers are opaque ids — no contact detail is served here.
          </p>
        </div>

        {decisions === null ? (
          <p className="empty">Worker decisions are unavailable right now.</p>
        ) : decisions.items.length === 0 ? (
          <p className="empty">No worker has applied to or skipped this posting yet.</p>
        ) : (
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">Recent worker decisions on this posting</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Worker</th>
                  <th scope="col">Decision</th>
                  <th scope="col">Skip reason</th>
                  <th scope="col">Match tier</th>
                  <th scope="col">Surface</th>
                </tr>
              </thead>
              <tbody>
                {decisions.items.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <time dateTime={a.created_at} title={formatTimestamp(a.created_at)}>
                        {formatRelative(a.created_at)}
                      </time>
                    </td>
                    <td>
                      <Link className="link mono" href={`/workers/${a.worker_id}`}>
                        {shortId(a.worker_id)}
                      </Link>
                    </td>
                    <td>
                      <StatusPill value={a.action} />
                    </td>
                    <td className="table__meta">{a.reason?.replace(/_/g, " ") ?? "—"}</td>
                    <td className="table__meta">
                      {a.match_tier === 1
                        ? "1 — asked-for skill"
                        : a.match_tier === 2
                          ? "2 — related skill"
                          : "—"}
                    </td>
                    <td className="table__meta">{a.source_surface}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
