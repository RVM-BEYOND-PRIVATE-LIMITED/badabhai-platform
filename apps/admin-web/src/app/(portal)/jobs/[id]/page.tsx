import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { jobRoleLabel } from "@badabhai/types";
import { requireCapability } from "../../../../lib/auth";
import { can } from "../../../../lib/auth/capabilities";
import { getJobPosting, listApplications } from "../../../../lib/entities";
import { isAdminRequestError } from "../../../../lib/admin-http";
import {
  formatCount,
  formatExperienceBand,
  formatPayBand,
  formatRelative,
  formatTimestamp,
  matchTierLabel,
  payTypeLabel,
  shortId,
} from "../../../../lib/format";
import { StatusPill } from "../../../../components/status-pill";
import { DetailList } from "../../../../components/detail-list";
import { Stat } from "../../../../components/stat";
import { JobDetailHeader } from "./job-detail-header";

/**
 * A poster-set list (requirements / benefits) as chips, or a plain fallback phrase when the
 * poster set none. An empty array is NOT null — it must still fall through to the phrase rather
 * than render an empty `<ul>`, so the check is on length, not just presence.
 */
function chipList(items: readonly string[] | null | undefined, empty: string): ReactNode {
  if (!items || items.length === 0) return empty;
  return (
    <ul className="chips">
      {items.map((item, i) => (
        <li className="chip" key={`${i}-${item}`}>
          {item}
        </li>
      ))}
    </ul>
  );
}

export const dynamic = "force-dynamic";
export const metadata = { title: "Posting details" };

/**
 * One posting — the full poster-typed content plus its reach.
 *
 * The description is shown in full and verbatim, because reviewing a posting for spam or a
 * misleading claim is one of the main reasons an operator opens this page, and a truncated
 * or prettified version would be the wrong thing to judge. It is already worker-visible.
 */
export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireCapability("read_entities");
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

  // Offered only to a reader who may open it: the timeline route is `read_events`.
  const timelineHref = can(session.capabilities, "read_events")
    ? `/jobs/${job.id}/timeline`
    : null;

  // The display role the payer picked (migration 0131). Labelled for a human; an unknown or
  // absent value never renders raw as a friendly label. `null` means no role was picked; a
  // non-null value the label map does not know is shown as its raw id in the monospace id face,
  // so it is still legible and copyable rather than a blank or a crash.
  const roleLabel = jobRoleLabel(job.role_kind);
  const roleValue: ReactNode =
    job.role_kind == null ? (
      "not set"
    ) : roleLabel !== null ? (
      roleLabel
    ) : (
      <span className="mono">{job.role_kind}</span>
    );

  const header = {
    back: { href: "/jobs", label: "Postings" },
    title: job.role_title,
    description: (
      <>
        One posting&rsquo;s full content, with its reach and its trust review. Published as{" "}
        <strong>{job.org_label}</strong>
        {job.city || job.location_label ? ` · ${job.city ?? job.location_label}` : ""} · created{" "}
        {formatRelative(job.created_at)}.
      </>
    ),
  };

  return (
    <div className="page">
      <JobDetailHeader
        header={header}
        jobId={job.id}
        status={job.status}
        canForceClose={can(session.capabilities, "force_close_posting")}
        timelineHref={timelineHref}
      />

      {job.status === "suspended" && (
        <section className="notice notice--bad" role="status">
          <strong>Hidden by a suspension.</strong> The owning account is suspended, so this
          posting is out of the worker feed. Reinstating the account restores it to{" "}
          <strong>{job.previous_status ?? "its previous state"}</strong> rather than forcing
          it open — a posting the customer had paused stays paused.
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
            <p className="panel__sub">
              What the poster set for this job. The role classification is internal and is not
              shown to workers.
            </p>
          </div>
          <DetailList
            items={[
              { label: "Role title", value: job.role_title },
              { label: "Role classification", value: roleValue },
              { label: "Published as", value: job.org_label },
              { label: "Location note", value: job.location_label ?? "not stated" },
              { label: "Match city", value: job.city ?? "not set" },
              { label: "Area / locality", value: job.area ?? "not stated" },
              { label: "Openings", value: job.vacancy_band },
              { label: "Monthly pay", value: formatPayBand(job.pay_min, job.pay_max) },
              {
                label: "Pay type",
                value: job.pay_type ? payTypeLabel(job.pay_type) : "not stated",
              },
              {
                label: "Experience",
                value: formatExperienceBand(
                  job.min_experience_years ?? null,
                  job.max_experience_years ?? null,
                ),
              },
              { label: "Shift", value: job.shift ?? "not stated" },
              { label: "Needed by", value: job.needed_by ?? "not stated" },
              { label: "Requirements", value: chipList(job.requirements, "none listed") },
              { label: "Benefits", value: chipList(job.benefits, "none listed") },
            ]}
          />
          <div className="prose">
            <h3 className="prose__head">Description</h3>
            {job.description ? (
              // `white-space: pre-wrap` — the poster's line breaks are part of what is being
              // reviewed, and collapsing them changes how the ad reads.
              <p className="prose__body">{job.description}</p>
            ) : (
              // h4, not h3: this sits UNDER the "Description" h3 inside the panel's h2.
              <div className="state">
                <h4 className="state__title">No description</h4>
                <p className="state__body">
                  The poster published this job without one, so workers judge it on the role
                  title, pay band and location alone. There is nothing here to review for a
                  misleading claim — an empty description is a quality signal, not a fault.
                </p>
              </div>
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
            <Stat label="Applied" value={formatCount(job.applied_count)} />
            <Stat label="Skipped" value={formatCount(job.skipped_count)} />
            {/* The tile is ALWAYS the apply rate; before anyone has seen the posting that rate
                does not exist, and the value says so as an absent statement rather than a dash
                under a label that changed name. */}
            <Stat
              label="Apply rate"
              value={applyRate === null ? "Not seen yet" : `${applyRate}%`}
              absent={applyRate === null}
            />
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
            Recent job decisions
          </h2>
          <p className="panel__sub">
            The ten most recent. Workers are opaque ids — no contact detail is served here.
          </p>
        </div>

        {decisions === null ? (
          <div className="state state--error">
            <h3 className="state__title">Job decisions could not be loaded</h3>
            <p className="state__body">
              The posting above loaded, but the job-decisions read failed — so this table is
              missing, not empty. The Applied and Skipped tiles come from the posting record
              and are still the true totals.
            </p>
            <div className="state__actions">
              <Link className="btn btn--ghost" href={`/jobs/${job.id}`}>
                Retry
              </Link>
            </div>
          </div>
        ) : decisions.items.length === 0 ? (
          <div className="state">
            <h3 className="state__title">No job decisions yet</h3>
            <p className="state__body">
              No worker has applied to this posting or skipped it.{" "}
              {job.status === "open"
                ? "It is open, so it is in the feed and waiting on matching to surface it to somebody."
                : `It is ${job.status}, so it is out of the worker feed and cannot collect decisions in this state.`}
            </p>
          </div>
        ) : (
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">Recent job decisions on this posting</caption>
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
                    <td className="table__meta">{matchTierLabel(a.match_tier)}</td>
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
