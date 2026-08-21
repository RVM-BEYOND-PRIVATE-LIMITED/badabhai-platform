import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCapability } from "../../../../lib/auth";
import { can } from "../../../../lib/auth/capabilities";
import { getWorker, listApplications } from "../../../../lib/entities";
import { isAdminRequestError } from "../../../../lib/admin-http";
import { identityPosture, displayName } from "../../../../lib/identity";
import { formatCount, formatRelative, formatTimestamp, shortId } from "../../../../lib/format";
import { StatusPill } from "../../../../components/status-pill";
import { NameCell } from "../../../../components/name-cell";
import { IdentityCapNotice } from "../../../../components/identity-notice";
import { DetailList } from "../../../../components/detail-list";
import { WorkerDetailHeader } from "./worker-detail-header";

export const dynamic = "force-dynamic";
export const metadata = { title: "Worker" };

/**
 * One worker.
 *
 * The 2026-08-18 ruling put the name on the DETAIL page as well as the list — the CTO was shown
 * the detail-only recommendation for v1 and chose both. So the heading is this worker's name
 * when one was disclosed, and the short id whenever one was not: a heading built from a value
 * that can legitimately be null cannot be allowed to render as an empty line, and the id is the
 * label the rest of the console already identifies them by.
 *
 * The id never leaves the page for the name's sake. It stays in the eyebrow's `title`, in the
 * Record list, and in every link out — it is the join key onto the audit spine, and a name is
 * not unique enough to be one.
 *
 * The most useful thing this page does is still link OUT — to the event timeline, which is where
 * the worker's actual history lives. The counters here are the summary; the spine is the record.
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

  // A single record, so the posture is read off this one row — `[worker]`, not a page.
  const posture = identityPosture(
    [worker],
    "full_name",
    can(session.capabilities, "read_identity"),
  );
  const name = displayName(worker.full_name);

  const title = (
    <div>
      <p className="page__eyebrow">
        <Link className="link" href="/workers">
          Workers
        </Link>
      </p>
      {/* `mono` is dropped with the id: it is an opaque-identifier treatment, and a person's
          name set in a monospace face reads as a machine token rather than as a name. */}
      <h1 className={name === null ? "page__title mono" : "page__title"}>
        {name ?? shortId(worker.id)}
      </h1>
      <p className="page__sub">
        {name === null
          ? "One worker account as this portal sees it — what they did."
          : "One worker account as this portal sees it — what they did, and who they are."}{" "}
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

      {posture === "capped" && (
        <IdentityCapNotice>
          Your role may see this worker&apos;s name, so the heading above falls back to their id:
          this admin account has spent its hourly name budget.
        </IdentityCapNotice>
      )}

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
            {/* THREE-VALUED, like the posture. A two-way branch here put "The name is
                decrypted for this response only." eight lines under a banner saying names
                were withheld — the capped case fell into the `named` copy because it was
                only ever tested for `faceless`. */}
            <p className="panel__sub">
              {posture === "faceless"
                ? "Names are not served to your role, and contact never appears on a record read for any role — revealing a worker's phone is a separate, reason-gated action."
                : posture === "capped"
                  ? "No name was decrypted for this response — see above. Contact never appears on a record read either — revealing a worker's phone is a separate, reason-gated action."
                  : "The name is decrypted for this response only. Contact never appears on a record read — revealing a worker's phone is a separate, reason-gated action."}
            </p>
          </div>
          <DetailList
            items={[
              // The row is present only in the `named` posture, for the same reason the list
              // column is: a dash on a "Name" row asserts that nobody recorded one.
              ...(posture === "named"
                ? [{ label: "Name", value: <NameCell value={worker.full_name} /> }]
                : []),
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
