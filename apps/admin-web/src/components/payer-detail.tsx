import Link from "next/link";
import type { JobPostingListItem, PayerDetail } from "../lib/entities";
import { formatCount, formatRelative, formatTimestamp, shortId } from "../lib/format";
import { StatusPill } from "./status-pill";
import { DetailList } from "./detail-list";

/**
 * One payer account — shared by Companies and Agencies, which differ only by `role`.
 *
 * The org labels shown here are read off this payer's OWN job postings (`org_label`), not
 * decrypted from the account. That distinction is stated on the page rather than smoothed
 * over: it is poster-typed free text, it can vary between postings, and it is not a
 * verified legal name. Presenting it as "Company name" would invite an operator to act on
 * it as identity — which is exactly the mistake worth preventing on a screen that sits
 * next to a suspend button.
 */
export function PayerDetailView({
  payer,
  postings,
  kind,
  backHref,
}: {
  payer: PayerDetail;
  /** This payer's postings, or null when that read failed. */
  postings: JobPostingListItem[] | null;
  kind: "Company" | "Agency";
  backHref: string;
}) {
  // Distinct labels this payer has published under, most recent first.
  const labels = postings ? [...new Set(postings.map((p) => p.org_label))] : [];

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <p className="page__eyebrow">
            <Link className="link" href={backHref}>
              {kind === "Company" ? "Companies" : "Agencies"}
            </Link>
          </p>
          <h1 className="page__title mono">{shortId(payer.id)}</h1>
          <p className="page__sub">
            One {kind === "Company" ? "employer" : "agency"} account — what it has posted
            and spent, not who registered it.{" "}
            {labels.length > 0 ? (
              <>
                Publishes as <strong>{labels.slice(0, 3).join(", ")}</strong>
                {labels.length > 3 && ` and ${labels.length - 3} more`} — self-declared on
                their job postings, not a verified name.
              </>
            ) : (
              <>
                No job postings yet, so there is no self-declared label to identify this
                account by.
              </>
            )}
          </p>
        </div>
        <div className="page__actions">
          <Link className="btn btn--ghost" href={`/events?subjectType=payer&subjectId=${payer.id}`}>
            View event timeline
          </Link>
        </div>
      </header>

      {payer.status === "suspended" && (
        <section className="notice notice--bad" role="status">
          <strong>Suspended.</strong> Their postings are hidden from the worker feed and
          their sessions are revoked. Reinstating restores each posting to the state it held
          before the suspension
          {payer.previous_status ? ` (the account returns to ${payer.previous_status})` : ""}.
        </section>
      )}

      <div className="cols">
        <section className="panel" aria-labelledby="p-record">
          <div className="panel__head">
            <h2 className="panel__title" id="p-record">
              Account
            </h2>
            <p className="panel__sub">
              Email, phone and registered organisation name are encrypted at rest and are
              not served to this portal.
            </p>
          </div>
          <DetailList
            items={[
              { label: `${kind} id`, value: <span className="mono">{payer.id}</span> },
              { label: "Role", value: payer.role === "agent" ? "Agency" : "Employer" },
              { label: "Status", value: <StatusPill value={payer.status} /> },
              {
                label: "Status before suspension",
                value: payer.previous_status ?? "never suspended",
              },
              {
                label: "Registered",
                value: (
                  <time dateTime={payer.created_at} title={formatTimestamp(payer.created_at)}>
                    {formatRelative(payer.created_at)}
                  </time>
                ),
              },
              {
                label: "Last change",
                value: (
                  <time dateTime={payer.updated_at} title={formatTimestamp(payer.updated_at)}>
                    {formatRelative(payer.updated_at)}
                  </time>
                ),
              },
            ]}
          />
        </section>

        <section className="panel" aria-labelledby="p-usage">
          <div className="panel__head">
            <h2 className="panel__title" id="p-usage">
              Usage
            </h2>
            <p className="panel__sub">Postings, unlocks and the current credit balance.</p>
          </div>
          <div className="stats stats--compact">
            <div className="stat">
              <span className="stat__value">{formatCount(payer.open_posting_count)}</span>
              <span className="stat__label">Open postings</span>
            </div>
            <div className="stat">
              <span className="stat__value">{formatCount(payer.posting_count)}</span>
              <span className="stat__label">Postings, all time</span>
            </div>
            <div className="stat">
              <span className="stat__value">{formatCount(payer.unlock_count)}</span>
              <span className="stat__label">Contacts unlocked</span>
            </div>
            <div className="stat">
              <span className="stat__value">{formatCount(payer.credit_balance)}</span>
              <span className="stat__label">Credit balance</span>
            </div>
          </div>
        </section>
      </div>

      <section className="panel" aria-labelledby="p-postings">
        <div className="panel__head panel__head--row">
          <div>
            <h2 className="panel__title" id="p-postings">
              Job postings
            </h2>
            <p className="panel__sub">The most recent postings this account has created.</p>
          </div>
          {payer.posting_count > 0 && (
            <Link className="btn btn--ghost" href={`/jobs?payerId=${payer.id}`}>
              All their postings
            </Link>
          )}
        </div>

        {postings === null ? (
          <div className="state state--error">
            <h3 className="state__title">Their postings could not be loaded</h3>
            <p className="state__body">
              The account record above loaded, but the postings read failed — so this table
              is missing, not empty. The same read supplies the self-declared labels in the
              header, which is why this account is described without one.
            </p>
            <div className="state__actions">
              <Link className="btn btn--ghost" href={`${backHref}/${payer.id}`}>
                Reload this account
              </Link>
            </div>
          </div>
        ) : postings.length === 0 ? (
          <div className="state">
            <h3 className="state__title">No job postings yet</h3>
            <p className="state__body">
              This account has never created one, so it has published nothing to workers and
              carries no self-declared label. A registered account that never posts is the
              normal shape of an abandoned signup — the event timeline shows how far it got.
            </p>
            <div className="state__actions">
              <Link
                className="btn btn--ghost"
                href={`/events?subjectType=payer&subjectId=${payer.id}`}
              >
                View event timeline
              </Link>
            </div>
          </div>
        ) : (
          <div className="tablewrap">
            <table className="table">
              <caption className="sr-only">Job postings for this account</caption>
              <thead>
                <tr>
                  <th scope="col">Role</th>
                  <th scope="col">Published as</th>
                  <th scope="col">Location</th>
                  <th scope="col">Status</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {postings.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <Link className="link" href={`/jobs/${j.id}`}>
                        {j.role_title}
                      </Link>
                    </td>
                    <td>{j.org_label}</td>
                    <td className="table__meta">{j.city ?? j.location_label ?? "—"}</td>
                    <td>
                      <StatusPill value={j.status} />
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
        )}
      </section>
    </div>
  );
}
