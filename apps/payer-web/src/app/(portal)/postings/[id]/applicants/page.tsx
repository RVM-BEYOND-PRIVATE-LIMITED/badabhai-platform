import Link from "next/link";
import { getApplicantFeed, getDashboard } from "../../../../../lib/payer-api";
import type { ApplicantFeed, Dashboard } from "../../../../../lib/contracts";
import { ApplicantActions } from "./applicant-actions";

export const dynamic = "force-dynamic";

/**
 * Faceless applicant feed for one of the payer's OWN postings (ADR-0019 Decision E).
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
      <p className="page-sub">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1 className="page-title">Applicants</h1>

      {notFound ? (
        <div className="empty">
          No posting found here. It may not exist, or it isn&rsquo;t one of your postings.
        </div>
      ) : feedError ? (
        <p className="page-sub">
          <span className="badge badge-warn">Service unavailable</span> We couldn&rsquo;t load
          applicants right now. Please retry.
        </p>
      ) : feed ? (
        <>
          <p className="page-sub">
            {feed.roleTitle} · {feed.applicants.length} faceless applicant
            {feed.applicants.length === 1 ? "" : "s"}
            {balance !== null ? (
              <>
                {" "}
                · <span className="badge">Balance: {balance}</span>
              </>
            ) : null}
          </p>
          <div className="note">
            Applicants are <strong>faceless</strong> — an opaque id plus deterministic relevance
            (rank / score / signals). No name, phone, or employer is shown. Unlocking spends 1
            credit and grants a <strong>routed</strong> contact (an opaque relay — never a phone).
            An &ldquo;unavailable&rdquo; result never discloses its cause.
          </div>

          {feed.applicants.length === 0 ? (
            <div className="empty">No applicants on this posting yet.</div>
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
        </>
      ) : null}
    </>
  );
}
