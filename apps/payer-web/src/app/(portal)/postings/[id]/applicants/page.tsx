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
export default async function ApplicantsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let feed: ApplicantFeed | null = null;
  let dashboard: Dashboard | null = null;
  let error: string | null = null;
  let notFound = false;
  try {
    [feed, dashboard] = await Promise.all([getApplicantFeed(id), getDashboard()]);
    if (!feed) notFound = true;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
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
      ) : error ? (
        <p className="page-sub">
          <span className="badge badge-warn">Service unavailable</span> We couldn&rsquo;t load
          applicants right now. Please retry.
        </p>
      ) : feed && dashboard ? (
        <>
          <p className="page-sub">
            {feed.roleTitle} ·{" "}
            {feed.applicants.length} faceless applicant{feed.applicants.length === 1 ? "" : "s"} ·{" "}
            <span className="badge">Balance: {dashboard.credits.balance}</span>
          </p>
          <div className="note">
            Applicants are <strong>faceless</strong> — only an opaque id, trade, banded experience,
            coarse city, and skills. No name, phone, or employer is shown. Unlocking spends 1 credit
            and grants a <strong>routed</strong> contact + a <strong>masked</strong> resume (no
            phone). An &ldquo;unavailable&rdquo; result never discloses its cause.
          </div>

          {feed.applicants.length === 0 ? (
            <div className="empty">No applicants on this posting yet.</div>
          ) : (
            <ApplicantActions
              postingId={feed.postingId}
              applicants={feed.applicants}
              balance={dashboard.credits.balance}
            />
          )}
        </>
      ) : null}
    </>
  );
}
