import Link from "next/link";
import { getApplicantFeed, getDashboard } from "../../../../../lib/payer-api";
import type { ApplicantFeed, Dashboard } from "../../../../../lib/contracts";
import { Badge, Card } from "../../../../../components/ds";
import { RetryButton } from "../../../../../components/retry-button";
import { ApplicantActions } from "./applicant-actions";

export const dynamic = "force-dynamic";

/**
 * Faceless applicant feed for one of the payer's OWN postings (ADR-0019 Decision E) —
 * composed onto the UI-1 page spine (page-back / page-head / alert / state). Visual layer
 * only; the data path, the two decoupled reads and every invariant below are unchanged.
 *
 * XB-A: the feed is fetched payer-scoped; a posting that isn't the payer's returns
 * null ⇒ a NEUTRAL not-found (no cross-tenant existence oracle). XB-C: applicants
 * are faceless (opaque id + banded taxonomy signals) — no name/phone/employer.
 */
export default async function ApplicantsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // The two concerns are DECOUPLED (C2): a failure fetching the balance/dashboard must
  // NOT blank the applicant feed. The feed is the page's primary content; the balance is
  // only an affordance signal. Each has its own try/catch and its own degraded state.
  let feed: ApplicantFeed | null = null;
  let feedError = false;
  let notFound = false;
  try {
    feed = await getApplicantFeed(id);
    if (!feed) notFound = true;
  } catch {
    feedError = true;
  }

  let balance: number | null = null;
  try {
    const dashboard: Dashboard = await getDashboard();
    balance = dashboard.credits.balance;
  } catch {
    // Balance unavailable → render the feed without the balance chip; never blank it.
    balance = null;
  }

  return (
    <>
      <p className="page-back">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <div className="page-head">
        <div className="page-head__text">
          <h1 className="page-head__title">Applicants</h1>
          <p className="page-head__sub">
            Everyone who applied to this posting, in the engine&rsquo;s best-first order and
            faceless until you unlock a contact.
          </p>
        </div>
      </div>

      {notFound ? (
        // NEUTRAL not-found (XB-A): the copy is the UNION of "does not exist" and "not yours",
        // so it can never be read as an existence oracle for another payer's posting.
        <Card>
          <div className="state">
            <span className="state__icon">
              <i className="ph ph-file-dashed" aria-hidden="true" />
            </span>
            <h2 className="state__title">No posting found here</h2>
            <p className="state__body">
              It may not exist, or it isn&rsquo;t one of your postings.
            </p>
            <div className="state__actions">
              <Link className="bb-btn bb-btn--secondary bb-btn--sm" href="/postings">
                <i className="ph ph-list-bullets" aria-hidden="true" />
                <span>Manage postings</span>
              </Link>
            </div>
          </div>
        </Card>
      ) : feedError ? (
        <Card>
          <div className="state state--error">
            <span className="state__icon">
              <i className="ph ph-warning-circle" aria-hidden="true" />
            </span>
            <h2 className="state__title">We couldn&rsquo;t load applicants</h2>
            <p className="state__body">
              This is usually temporary — nothing about this posting has changed. Please retry.
            </p>
            <div className="state__actions">
              <RetryButton />
            </div>
          </div>
        </Card>
      ) : feed ? (
        <>
          <div className="alert alert--info">
            <i className="ph ph-mask-happy alert__icon" aria-hidden="true" />
            <div className="alert__text">
              <p className="alert__title">Applicants are faceless</p>
              <p className="alert__body">
                Each row is an opaque id plus deterministic relevance (rank / score / signals),
                shown in the engine&rsquo;s best-first order. No name, phone, or employer is
                shown. Sort them with <strong>Keep</strong> (→ Shortlist) and{" "}
                <strong>Pass</strong> (dismiss). <strong>Call</strong> / <strong>WhatsApp</strong>{" "}
                open only after you unlock and reveal a candidate&rsquo;s <strong>routed</strong>{" "}
                contact — an opaque relay, never a phone. Unlocking spends 1 credit. An
                &ldquo;unavailable&rdquo; result never discloses its cause.
              </p>
            </div>
          </div>

          {/* The feed itself is a run of cards that carry their own surface, so it is a
              `.section` (a titled block) rather than a `.panel` — a panel around them would
              be a box inside a box. The role title is the section heading; the balance is an
              affordance chip beside it, never a statement about any candidate. */}
          <section className="section">
            <div className="section__head">
              <h2 className="section__title">{feed.roleTitle}</h2>
              {balance !== null ? (
                <div className="section__actions">
                  <Badge tone="neutral">
                    Balance: <span className="bb-mono">{balance}</span>
                  </Badge>
                </div>
              ) : null}
              <p className="section__sub">
                {feed.applicants.length} faceless applicant
                {feed.applicants.length === 1 ? "" : "s"}
              </p>
            </div>

            {feed.applicants.length === 0 ? (
              <Card>
                <div className="state">
                  <span className="state__icon">
                    <i className="ph ph-users-three" aria-hidden="true" />
                  </span>
                  <h3 className="state__title">No applicants on this posting yet</h3>
                  <p className="state__body">
                    Matching workers appear here — faceless — as they apply. Nothing is needed
                    from you meanwhile; a wider skill list on the posting reaches more of them.
                  </p>
                  <div className="state__actions">
                    <Link className="bb-btn bb-btn--secondary bb-btn--sm" href="/postings">
                      <i className="ph ph-list-bullets" aria-hidden="true" />
                      <span>Manage postings</span>
                    </Link>
                  </div>
                </div>
              </Card>
            ) : (
              <ApplicantActions
                postingId={feed.postingId}
                applicants={feed.applicants}
                // Balance is an affordance hint only. If it failed to load (null), keep
                // unlock ENABLED — the no-oracle server still makes the real decision; we
                // never block on a UI-side balance we couldn't read.
                balance={balance ?? 1}
              />
            )}
          </section>
        </>
      ) : null}
    </>
  );
}
