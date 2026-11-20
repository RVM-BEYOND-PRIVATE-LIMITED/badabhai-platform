import Link from "next/link";
import { notFound } from "next/navigation";
import { can } from "../../../../../lib/auth/capabilities";
import { requireCapability } from "../../../../../lib/auth";
import { isAdminRequestError } from "../../../../../lib/admin-http";
import { getReachCase, reachCaseLabel, timeLeft } from "../../../../../lib/reach-desk";
import { PageHeader } from "../../../../../components/page-header";
import { StatusPill } from "../../../../../components/status-pill";
import { ReachCaseActions } from "../../../../../components/reach-case-actions";
import { formatTimestamp, shortId } from "../../../../../lib/format";
import { customerHref } from "../../../../../lib/customer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reach case" };

/**
 * #2750 items 7 and 8 — one couldn't-reach case: the case facts, the attempt log, and the desk's
 * actions. Gated on `work_reach_desk`; the reveal needs `reveal_pii` as well.
 */
export default async function ReachCasePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireCapability("work_reach_desk");
  const { id } = await params;

  let view: Awaited<ReturnType<typeof getReachCase>>;
  try {
    view = await getReachCase(id);
  } catch (err) {
    if (isAdminRequestError(err) && (err.status === 404 || err.status === 400)) notFound();
    throw err;
  }

  const closed = view.status !== "open";
  const canReveal = can(session.capabilities, "reveal_pii");

  return (
    <div className="page page--reading">
      <PageHeader
        title={`Reach case ${shortId(view.case_id)}`}
        description={`Reported by ${shortId(view.payer_id)} on ${formatTimestamp(view.reported_at)}.`}
      />

      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">Case</h2>
          <StatusPill value={view.status} label={reachCaseLabel(view.status)} />
        </div>
        <dl className="stats stats--compact">
          <div>
            <dt>Deadline</dt>
            <dd>
              {closed ? formatTimestamp(view.deadline_at) : `${timeLeft(view.deadline_at, Date.now())} · ${formatTimestamp(view.deadline_at)}`}
            </dd>
          </div>
          <div>
            <dt>Attempts</dt>
            <dd>{view.attempts}</dd>
          </div>
          <div>
            <dt>Credits returned</dt>
            <dd>{view.credits_returned}</dd>
          </div>
        </dl>
        <p className="panel__sub">
          <Link href={customerHref(view.payer_id)}>Company</Link>
          {view.worker_id ? (
            <>
              {" · "}
              <Link href={`/candidates/${view.worker_id}`}>Worker</Link>
            </>
          ) : null}
        </p>
        <ReachCaseActions
          caseId={view.case_id}
          workerId={view.worker_id}
          closed={closed}
          canReveal={canReveal}
          attempts={view.attempt_log.map((a) => ({
            attempt_id: a.attempt_id,
            result: a.result,
            attempted_at: a.attempted_at,
          }))}
        />
      </section>
    </div>
  );
}
