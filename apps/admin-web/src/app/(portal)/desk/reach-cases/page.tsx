import Link from "next/link";
import { requireCapability } from "../../../../lib/auth";
import { isAdminRequestError } from "../../../../lib/admin-http";
import {
  listReachCases,
  reachCaseLabel,
  timeLeft,
  type ReachCaseStatus,
} from "../../../../lib/reach-desk";
import { PageHeader } from "../../../../components/page-header";
import { StatusPill } from "../../../../components/status-pill";
import { formatTimestamp, shortId } from "../../../../lib/format";
import { customerHref } from "../../../../lib/customer";

export const dynamic = "force-dynamic";
export const metadata = { title: "Worker desk" };

const TABS: readonly { value: ReachCaseStatus; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "all", label: "All" },
];

function parseStatus(value: string | undefined): ReachCaseStatus {
  return value === "resolved" || value === "all" ? value : "open";
}

/**
 * #2750 items 7 and 8 — the worker desk queue.
 *
 * Open cases come nearest deadline first. The case page holds the reveal, the attempt log and the
 * close. Everything is gated on `work_reach_desk`; the API answers 404 while the credit rules are
 * off, which this page states rather than treating as a failure.
 */
export default async function WorkerDeskPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCapability("work_reach_desk");
  const sp = await searchParams;
  const one = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
  const status = parseStatus(one(sp.status));
  const cursor = one(sp.cursor);

  let page: Awaited<ReturnType<typeof listReachCases>>;
  try {
    page = await listReachCases({ status, ...(cursor ? { cursor } : {}), limit: 50 });
  } catch (err) {
    if (isAdminRequestError(err) && err.status === 404) {
      return (
        <div className="page page--reading">
          <PageHeader
            title="Worker desk"
            description="Cases where a company could not reach a worker it opened."
          />
          <section className="panel">
            <div className="state">
              <h2 className="state__title">The desk is not switched on yet</h2>
              <p className="state__body">
                It arrives with the credit rules. Until that switch is on, no company can report a
                case.
              </p>
            </div>
          </section>
        </div>
      );
    }
    throw err;
  }

  const now = Date.now();
  const href = (next: ReachCaseStatus, nextCursor?: string | null) => {
    const q = new URLSearchParams();
    if (next !== "open") q.set("status", next);
    if (nextCursor) q.set("cursor", nextCursor);
    const qs = q.toString();
    return `/desk/reach-cases${qs ? `?${qs}` : ""}`;
  };

  return (
    <div className="page page--reading">
      <PageHeader
        title="Worker desk"
        description="Cases where a company could not reach a worker it opened."
      />

      <nav className="filter-chips" aria-label="Case status">
        {TABS.map((tab) => (
          <Link
            key={tab.value}
            className={`btn btn--sm${tab.value === status ? " btn--selected" : ""}`}
            href={href(tab.value)}
            aria-current={tab.value === status ? "true" : undefined}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {page.cases.length === 0 ? (
        <section className="panel">
          <div className="state">
            <h2 className="state__title">No cases here</h2>
            <p className="state__body">
              {status === "open"
                ? "No open case needs a call. A case is opened when a company reports it could not reach a worker."
                : "No case matches this filter."}
            </p>
          </div>
        </section>
      ) : (
        <section className="panel">
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">Couldn&apos;t-reach cases</caption>
              <thead>
                <tr>
                  <th scope="col">Case</th>
                  <th scope="col">Company</th>
                  <th scope="col">Status</th>
                  <th scope="col">Reported</th>
                  <th scope="col">Deadline</th>
                  <th scope="col">Attempts</th>
                  <th scope="col">Credits returned</th>
                </tr>
              </thead>
              <tbody>
                {page.cases.map((c) => (
                  <tr key={c.case_id}>
                    <td>
                      <Link href={`/desk/reach-cases/${c.case_id}`}>{shortId(c.case_id)}</Link>
                    </td>
                    <td>
                      <Link href={customerHref(c.payer_id)}>{shortId(c.payer_id)}</Link>
                    </td>
                    <td>
                      <StatusPill value={c.status} label={reachCaseLabel(c.status)} />
                    </td>
                    <td>{formatTimestamp(c.reported_at)}</td>
                    <td>
                      {c.status === "open" ? timeLeft(c.deadline_at, now) : "—"}
                      <span className="table__meta"> {formatTimestamp(c.deadline_at)}</span>
                    </td>
                    <td className="ui-num">{c.attempts}</td>
                    <td className="ui-num">{c.credits_returned}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {page.next_cursor ? (
            <div className="state__actions">
              <Link className="btn btn--ghost" href={href(status, page.next_cursor)}>
                Next page
              </Link>
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}
