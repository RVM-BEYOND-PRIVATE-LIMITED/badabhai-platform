import Link from "next/link";
import { requireCapability } from "../../../lib/auth";
import { listJobPostings } from "../../../lib/entities";
import { formatPayBand, formatRelative, formatTimestamp, shortId } from "../../../lib/format";
import { StatusPill } from "../../../components/status-pill";
import { Pager } from "../../../components/pager";
import { JobFilterBar } from "./filter-bar";

export const dynamic = "force-dynamic";
export const metadata = { title: "Jobs" };

/**
 * Job postings — and, in practice, the entry point for most operational work.
 *
 * This is the only entity list with human-readable text on it (`org_label`, `role_title`,
 * `location_label`), because those are poster-typed fields already shown to every worker
 * in the feed. That makes this the screen where an operator actually FINDS things: a spam
 * or misleading posting is identifiable here, and its owner account is one click away.
 * Workers, Companies and Agencies are opaque by design and are reached through here.
 */
export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCapability("read_entities");

  const sp = await searchParams;
  const one = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

  const status = one(sp.status);
  const verificationStatus = one(sp.verificationStatus);
  const payerId = one(sp.payerId);
  const cursor = one(sp.cursor);

  let page: Awaited<ReturnType<typeof listJobPostings>> | null = null;
  let failed = false;
  try {
    page = await listJobPostings({ status, verificationStatus, payerId, cursor });
  } catch {
    // Most likely a malformed payer uuid. A user error renders inline; it does not take
    // the screen down.
    failed = true;
  }

  const filtered = Boolean(status || verificationStatus || payerId);

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">Jobs</h1>
          <p className="page__sub">
            Every job posting on the platform. Company and role text is what the poster
            typed — the same text workers see in the feed.
          </p>
        </div>
      </header>

      <section className="panel" aria-labelledby="jf-heading">
        <h2 className="sr-only" id="jf-heading">
          Filter job postings
        </h2>
        <JobFilterBar
          status={status ?? ""}
          verificationStatus={verificationStatus ?? ""}
          payerId={payerId ?? ""}
        />
      </section>

      <section className="panel" aria-labelledby="jr-heading" aria-live="polite">
        <div className="panel__head panel__head--row">
          <div>
            <h2 className="panel__title" id="jr-heading">
              Results
            </h2>
            <p className="panel__sub">
              {failed
                ? "That filter combination was rejected."
                : `${page?.items.length ?? 0} posting${page?.items.length === 1 ? "" : "s"} on this page.`}
            </p>
          </div>
          {filtered && (
            <Link className="btn btn--ghost" href="/jobs">
              Clear filters
            </Link>
          )}
        </div>

        {failed ? (
          <div className="state state--error">
            <h3 className="state__title">The server rejected these filters</h3>
            <p className="state__body">
              Nothing was fetched. An owner account id must be a full UUID — a short id
              copied from a table cell will not do. Correct the value above, or clear the
              filters and start again.
            </p>
            <div className="state__actions">
              <Link className="btn btn--ghost" href="/jobs">
                Clear filters
              </Link>
            </div>
          </div>
        ) : page && page.items.length > 0 ? (
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">Job postings, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Role</th>
                  <th scope="col">Published as</th>
                  <th scope="col">Location</th>
                  <th scope="col">Pay</th>
                  <th scope="col">Status</th>
                  <th scope="col">Trust</th>
                  <th scope="col">Owner</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <Link className="link" href={`/jobs/${j.id}`}>
                        {j.role_title}
                      </Link>
                      <span className="table__meta">{j.vacancy_band} vacancies</span>
                    </td>
                    <td>{j.org_label}</td>
                    <td className="table__meta">{j.city ?? j.location_label ?? "—"}</td>
                    <td className="table__meta">{formatPayBand(j.pay_min, j.pay_max)}</td>
                    <td>
                      <StatusPill value={j.status} />
                    </td>
                    <td>
                      <StatusPill value={j.verification_status} />
                    </td>
                    <td>
                      {j.payer_id ? (
                        <Link className="link mono" href={`/companies/${j.payer_id}`} title={j.payer_id}>
                          {shortId(j.payer_id)}
                        </Link>
                      ) : (
                        // No payer_id means ops created it directly — there is no customer
                        // account behind it, and saying so beats a dead link.
                        <span className="table__meta">ops-created</span>
                      )}
                    </td>
                    <td>
                      <time dateTime={j.created_at} title={formatTimestamp(j.created_at)}>
                        {formatRelative(j.created_at)}
                      </time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : filtered ? (
          <div className="state">
            <h3 className="state__title">No postings match these filters</h3>
            <p className="state__body">
              Nothing matches the filters currently applied. Widen them, or clear them to
              see every posting on the platform.
            </p>
            <div className="state__actions">
              <Link className="btn btn--ghost" href="/jobs">
                Clear filters
              </Link>
            </div>
          </div>
        ) : (
          <div className="state">
            <h3 className="state__title">No job postings created yet</h3>
            <p className="state__body">
              Postings appear here the moment an employer or an operator publishes one.
              Until then there is nothing in the feed workers see either.
            </p>
            <div className="state__actions">
              <Link className="btn btn--ghost" href="/events">
                Open the event timeline
              </Link>
            </div>
          </div>
        )}

        <Pager
          basePath="/jobs"
          params={{ status, verificationStatus, payerId }}
          nextCursor={page?.nextCursor}
        />
      </section>
    </div>
  );
}
