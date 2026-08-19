import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "../../../../lib/auth";
import { can } from "../../../../lib/auth/capabilities";
import { getWorker, listApplications } from "../../../../lib/entities";
import { isAdminRequestError } from "../../../../lib/admin-http";
import { formatCount, formatRelative, formatTimestamp, shortId } from "../../../../lib/format";
import { StatusPill } from "../../../../components/status-pill";
import { DetailList } from "../../../../components/detail-list";
import { WorkerDetailHeader } from "./worker-detail-header";

export const dynamic = "force-dynamic";
export const metadata = { title: "Worker" };

/**
 * One worker, faceless.
 *
 * The most useful thing this page does is link OUT — to the event timeline, which is where
 * the worker's actual history lives. The counters here are the summary; the spine is the
 * record.
 */
export default async function WorkerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireCapability("read_entities");
  const { id } = await params;

  let worker: Awaited<ReturnType<typeof getWorker>>;
  try {
    worker = await getWorker(id);
  } catch (err) {
    // 404 (unknown id) and 400 (not a uuid) are both "no such worker" from the operator's
    // point of view. A malformed id pasted from a chat log should land on not-found, not
    // on a stack trace.
    if (isAdminRequestError(err) && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }

  // Their decisions. Non-fatal: a failure here must not blank the whole worker page.
  const apps = await listApplications({ workerId: id, limit: 10 }).catch(() => null);

  const timelineHref = `/workers/${worker.id}/timeline`;
  const journeyHref = `/workers/${worker.id}/journey`;
  const title = (
    <div>
      <p className="page__eyebrow">
        <Link className="link" href="/workers">
          Workers
        </Link>
      </p>
      <h1 className="page__title mono">{shortId(worker.id)}</h1>
      <p className="page__sub">
        One worker account as this portal sees it — what they did, never who they are.
        Registered {formatRelative(worker.created_at)} · {formatTimestamp(worker.created_at)}.
      </p>
    </div>
  );

  return (
    <div className="page">
      <WorkerDetailHeader
        title={title}
        workerId={worker.id}
        canFlag={can(session.capabilities, "flag_worker")}
        timelineHref={timelineHref}
        /* This page is already behind `read_entities`, which is what the journey routes
           declare too — so the link is always offered here. Passed explicitly rather than
           hardcoded in the header, so the day either capability narrows the control moves
           with it instead of pointing at a redirect. */
        journeyHref={can(session.capabilities, "read_entities") ? journeyHref : null}
      />

      {worker.deletion_scheduled_at && (
        <section className="notice notice--bad" role="status">
          <strong>Deletion scheduled.</strong> This worker requested account deletion; the
          hard delete runs {formatRelative(worker.deletion_scheduled_at)} (
          {formatTimestamp(worker.deletion_scheduled_at)}). It is cancellable by the worker
          until then, and irreversible afterwards.
        </section>
      )}

      <div className="cols">
        <section className="panel" aria-labelledby="w-identity">
          <div className="panel__head">
            <h2 className="panel__title" id="w-identity">
              Record
            </h2>
            <p className="panel__sub">
              Name and contact are not part of this record — they are never served to a
              list or detail read.
            </p>
          </div>
          <DetailList
            items={[
              { label: "Worker id", value: <span className="mono">{worker.id}</span> },
              { label: "Status", value: <StatusPill value={worker.status} /> },
              { label: "Preferred language", value: worker.preferred_language ?? "not set" },
              {
                label: "Profile",
                value: worker.profile_status ? (
                  <>
                    <StatusPill value={worker.profile_status} />
                    {worker.profile_updated_at && (
                      <span className="table__meta">
                        {" "}
                        updated {formatRelative(worker.profile_updated_at)}
                      </span>
                    )}
                  </>
                ) : (
                  "never started"
                ),
              },
              { label: "Resume generated", value: worker.has_resume ? "yes" : "no" },
              {
                label: "Last updated",
                value: (
                  <time dateTime={worker.updated_at} title={formatTimestamp(worker.updated_at)}>
                    {formatRelative(worker.updated_at)}
                  </time>
                ),
              },
            ]}
          />
        </section>

        <section className="panel" aria-labelledby="w-activity">
          <div className="panel__head">
            <h2 className="panel__title" id="w-activity">
              Activity
            </h2>
            <p className="panel__sub">Counts across the whole account lifetime.</p>
          </div>
          <div className="stats stats--compact">
            <div className="stat">
              <span className="stat__value">{formatCount(worker.application_count)}</span>
              <span className="stat__label">Job decisions</span>
            </div>
            <div className="stat">
              <span className="stat__value">{formatCount(worker.unlock_count)}</span>
              <span className="stat__label">Times unlocked</span>
            </div>
          </div>
          <DetailList
            items={[
              { label: "Profile photo", value: worker.has_photo ? "uploaded" : "none" },
              {
                label: "Shows photo on resume",
                value: worker.resume_show_photo ? "yes" : "no",
              },
              {
                label: "Night shift ready",
                value: worker.resume_night_shift_ready ? "yes" : "no",
              },
            ]}
          />
        </section>
      </div>

      <section className="panel" aria-labelledby="w-apps">
        <div className="panel__head">
          <h2 className="panel__title" id="w-apps">
            Recent job decisions
          </h2>
          <p className="panel__sub">The ten most recent applies and skips.</p>
        </div>

        {apps === null ? (
          // No retry LINK on this screen, unlike the other detail pages: the retry target is
          // this page's own URL, which carries the worker id, and nothing on the faceless
          // side of the portal grows a new worker-id-bearing href for a convenience. The
          // recovery instruction is in the body instead.
          <div className="state state--error">
            <h3 className="state__title">Job decisions could not be loaded</h3>
            <p className="state__body">
              The worker record above loaded, but the applications read failed — so this
              table is missing, not empty. The &ldquo;Job decisions&rdquo; counter above is
              read from the worker record and is still the true total. Reload this page; if
              it keeps failing, the event timeline holds the same applies and skips as audit
              records.
            </p>
          </div>
        ) : apps.items.length === 0 ? (
          <div className="state">
            <h3 className="state__title">No job decisions yet</h3>
            <p className="state__body">
              This worker has not applied to or skipped a posting. Nothing is broken — it is
              the normal state of a new account, but it also means matching has no
              engagement signal for them yet, so they will rank cold until they swipe.
            </p>
          </div>
        ) : (
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">Recent job decisions</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Decision</th>
                  <th scope="col">Job</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Match tier</th>
                </tr>
              </thead>
              <tbody>
                {apps.items.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <time dateTime={a.created_at} title={formatTimestamp(a.created_at)}>
                        {formatRelative(a.created_at)}
                      </time>
                    </td>
                    <td>
                      <StatusPill value={a.action} />
                    </td>
                    <td>
                      {a.job_posting_id ? (
                        <Link className="link mono" href={`/jobs/${a.job_posting_id}`}>
                          {shortId(a.job_posting_id)}
                        </Link>
                      ) : (
                        // A pre-V1 decision points at the legacy `jobs` table, which has no
                        // portal screen. Saying so is better than a dead link.
                        <span className="mono" title="Legacy job (pre-Matching-V1)">
                          {shortId(a.job_id)}
                        </span>
                      )}
                    </td>
                    <td className="table__meta">{a.reason?.replace(/_/g, " ") ?? "—"}</td>
                    <td className="table__meta">{a.match_tier ?? "—"}</td>
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
