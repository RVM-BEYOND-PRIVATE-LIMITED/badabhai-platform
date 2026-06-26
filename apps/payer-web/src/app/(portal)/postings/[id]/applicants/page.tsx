import Link from "next/link";
import { getApplicantFeed, getDashboard } from "../../../../../lib/payer-api";
import type { ApplicantFeed, Dashboard } from "../../../../../lib/contracts";
import { Badge, Card } from "../../../../../components/ds";
import { RetryButton } from "../../../../../components/retry-button";
import { ApplicantActions } from "./applicant-actions";

export const dynamic = "force-dynamic";

/**
 * Faceless applicant feed for one of the payer's OWN postings (ADR-0019 Decision E) —
 * DS1.3 re-skin onto the BadaBhai Design System (visual only; data path unchanged).
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
      <p className="applicants-back">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1 className="applicants-title">Applicants</h1>

      {notFound ? (
        <Card variant="flat" className="applicants-empty">
          No posting found here. It may not exist, or it isn&rsquo;t one of your postings.
        </Card>
      ) : feedError ? (
        <Card variant="outline" className="applicants-state">
          <Badge tone="warning" upper>
            Service unavailable
          </Badge>
          <p className="applicants-state__msg">
            We couldn&rsquo;t load applicants right now. Please retry.
          </p>
          <RetryButton />
        </Card>
      ) : feed ? (
        <>
          <div className="applicants-meta">
            <span>
              {feed.roleTitle} · {feed.applicants.length} faceless applicant
              {feed.applicants.length === 1 ? "" : "s"}
            </span>
            {balance !== null ? (
              <Badge tone="neutral">
                Balance: <span className="bb-mono">{balance}</span>
              </Badge>
            ) : null}
          </div>
          <Card variant="flat" className="applicants-explainer">
            Applicants are <strong>faceless</strong> — an opaque id plus deterministic relevance
            (rank / score / signals), shown in the engine&rsquo;s best-first order. No name, phone,
            or employer is shown. Sort them with <strong>Keep</strong> (→ Shortlist) and{" "}
            <strong>Pass</strong> (dismiss). <strong>Call</strong> / <strong>WhatsApp</strong> open
            only after you unlock and reveal a candidate&rsquo;s <strong>routed</strong> contact —
            an opaque relay, never a phone. Unlocking spends 1 credit. An
            &ldquo;unavailable&rdquo; result never discloses its cause.
          </Card>

          {feed.applicants.length === 0 ? (
            <Card variant="flat" className="applicants-empty">
              No applicants on this posting yet.
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
        </>
      ) : null}
    </>
  );
}
