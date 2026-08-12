import Link from "next/link";
import { requireAgent } from "../../../../lib/auth/roles";
import {
  getAgencyEarnings,
  getAgencyKyc,
  getAgencyReferralsSummary,
  listAgencyPayouts,
} from "../../../../lib/payer-api";
import { assertNoAgencyPII } from "../../../../lib/assert-no-agency-pii";
import { kAnonCount } from "../../../../lib/agency-view";
import type {
  AgencyEarnings,
  AgencyKyc,
  AgencyPayout,
  AgencyReferralsSummary,
} from "../../../../lib/contracts";
import { ProgressBar, StatTile } from "../../../../components/ds";
import { RetryButton } from "../../../../components/retry-button";
import { AgencyBatchInvitePanel } from "../dashboard/batch-invite-panel";
import { AgencyInvitePanel } from "../dashboard/invite-panel";
import { EarningsPanel } from "./earnings-panel";
import { KycPanel } from "./kyc-panel";
import { PayoutPanel } from "./payout-panel";

export const dynamic = "force-dynamic";

/**
 * Agency-only "Referrals & earnings" (ADR-0022 Amendment 2) — the agency SUPPLY-money
 * surface: a shareable referral link, the aggregate referral funnel, referral EARNINGS,
 * payout KYC, and payout requests. MOCK money (no real disbursement).
 *
 * SECURITY (role authz / XB-A): `requireAgent()` is the FIRST statement — an employer
 * session gets a NEUTRAL 404 (no oracle, no client hide) before any read runs. Every
 * server action re-asserts the gate itself. Tenancy is the SESSION (no body payer_id).
 *
 * FACELESS (CLAUDE.md §2 #2 / B-R2): the funnel is AGGREGATE-ONLY with the k-anon floor
 * applied server-side; the earnings/KYC/payout reads are amounts/counts/status + the
 * MASKED KYC last-4 only. Every payload crosses {@link assertNoAgencyPII} at the seam.
 *
 * GATE (fail-closed): while `AGENCY_PAYOUTS_ENABLED` is OFF (the default) the
 * earnings/KYC/payout routes return 404 → the seam maps that to `null` and this page
 * renders a graceful "coming soon" inert panel, NOT an error. The referral link + funnel
 * stay LIVE either way.
 */
export default async function AgencyReferralsPage() {
  // 1) SERVER-enforced role gate — an `employer` session 404s here before any read runs.
  await requireAgent();

  // 2) LIVE aggregate funnel read (ungated), k-anon floored server-side. Isolated so a
  //    failure degrades to a neutral retry Card rather than blanking the page.
  let summary: AgencyReferralsSummary | null = null;
  let funnelError = false;
  try {
    summary = assertNoAgencyPII(
      await getAgencyReferralsSummary(),
      "payer/agency/referrals/summary",
    );
  } catch {
    funnelError = true;
  }
  const pct = summary ? conversionPct(summary) : null;

  // 3) GATED earnings read. `null` = supply payouts not enabled (404 → coming soon); a
  //    thrown error is a transient degrade (retry), distinct from "not enabled".
  let earnings: AgencyEarnings | null = null;
  let payoutsEnabled = true;
  let earningsError = false;
  try {
    const res = await getAgencyEarnings();
    if (res === null) payoutsEnabled = false; // gated route (404) — not enabled yet.
    else earnings = res;
  } catch {
    earningsError = true;
  }

  // 4) Only when earnings loaded do we read KYC + payout history (same gate). Each isolated.
  let kyc: AgencyKyc | null = null;
  let payouts: AgencyPayout[] = [];
  if (earnings && payoutsEnabled) {
    const [kycRes, payoutsRes] = await Promise.allSettled([getAgencyKyc(), listAgencyPayouts()]);
    if (kycRes.status === "fulfilled" && kycRes.value) kyc = kycRes.value;
    if (payoutsRes.status === "fulfilled" && payoutsRes.value) payouts = payoutsRes.value;
  }
  // If earnings loaded but KYC didn't come back, default to not_submitted so the form shows.
  const kycForPanel: AgencyKyc = kyc ?? {
    status: "not_submitted",
    panLast4: null,
    bankLast4: null,
    rejectReason: null,
    updatedAt: null,
  };

  return (
    <>
      <p className="page-back">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <div className="page-head">
        <div className="page-head__text">
          <h1 className="page-head__title">Referrals &amp; earnings</h1>
          <p className="page-head__sub">
            Share your referral link, track your consent-safe funnel, and — where enabled —
            earn a mock rev-share when workers you referred get contacted. BadaBhai protects
            worker privacy: agencies see aggregate counts, never a per-worker breakdown.
          </p>
        </div>
      </div>

      {/* a) REFERRAL LINK — LIVE faceless mint (opaque code/link + copy; consent-first). */}
      <AgencyInvitePanel />

      {/*
        a2) BATCH MINT — the same faceless mint, N at a time (≤50) for a gate drive or a
        print run. Cardinality-shaped: the ONLY inputs are a count and one shared non-PII
        tag. This is NOT the parked "Bulk Invite Upload" (dead by design — it ingests worker
        contacts); nothing here accepts, stores or sends a worker identity.

        `id` is the in-page anchor target for the dashboard's "Batch invites" tile
        (/agency/referrals#batch-invites) — the batch mint's entry point from "Invite tools".
      */}
      <div id="batch-invites">
        <AgencyBatchInvitePanel />
      </div>

      {/*
        b) REFERRAL FUNNEL — LIVE aggregate, k-anon floored (no per-invitee oracle).

        A `.section` (not a `.panel`): the body is a run of StatTiles that already carry their
        own surface, so a bordered frame around them would be a box inside a box. The k-anon
        disclosure is the section's SUB — it describes the whole funnel, so it reads before the
        numbers rather than as a footnote after them.
      */}
      <section className="section">
        <div className="section__head">
          <h2 className="section__title">Referral funnel</h2>
          {summary && !funnelError ? (
            <p className="section__sub">
              Aggregate only — counts below {summary.minBucket} show as &ldquo;&lt;
              {summary.minBucket}&rdquo; to protect a single worker&rsquo;s privacy. There is
              no per-worker breakdown.
            </p>
          ) : null}
        </div>
        {summary && !funnelError ? (
          <>
            <div className="stat-row">
              <StatTile
                label="Invites created"
                value={kAnonCount(summary.created, summary.minBucket)}
                icon="link"
              />
              <StatTile
                label="Clicked"
                value={kAnonCount(summary.clicked, summary.minBucket)}
                icon="cursor-click"
              />
              <StatTile
                label="Accepted"
                value={kAnonCount(summary.accepted, summary.minBucket)}
                icon="seal-check"
              />
            </div>

            <ProgressBar
              tone="success"
              label="Created → clicked conversion"
              value={pct ?? 0}
              showValue={pct !== null}
            />
            {pct === null && (
              <p className="section__sub">
                Conversion appears once both stages clear the privacy floor of{" "}
                {summary.minBucket}.
              </p>
            )}
          </>
        ) : (
          <div className="state state--error">
            <span className="state__icon">
              <i className="ph ph-warning-circle" aria-hidden="true" />
            </span>
            <h3 className="state__title">Referral funnel unavailable</h3>
            <p className="state__body">
              Your funnel counts could not load right now. Nothing has changed — your invites
              and referrals are safe. Please retry shortly.
            </p>
            <div className="state__actions">
              <RetryButton />
            </div>
          </div>
        )}
      </section>

      {/* c) SUPPLY MONEY — earnings + KYC + payout, gated behind AGENCY_PAYOUTS_ENABLED. */}
      {earningsError ? (
        <section className="section">
          <div className="section__head">
            <h2 className="section__title">Your earnings</h2>
          </div>
          <div className="state state--error">
            <span className="state__icon">
              <i className="ph ph-warning-circle" aria-hidden="true" />
            </span>
            <h3 className="state__title">Earnings unavailable</h3>
            <p className="state__body">
              Your earnings could not load right now. Nothing has changed — anything you have
              accrued is still there. Please retry shortly.
            </p>
            <div className="state__actions">
              <RetryButton />
            </div>
          </div>
        </section>
      ) : !payoutsEnabled ? (
        <section className="section">
          <div className="section__head">
            <h2 className="section__title">Earnings &amp; payouts</h2>
            <div className="section__actions">
              <span className="soon-badge">Soon</span>
            </div>
          </div>
          {/* `aria-disabled` is kept: the block is a placeholder for a surface that is real on
              the server but not switched on, and nothing in it is operable. */}
          <div className="soon-card" aria-disabled="true">
            <h3 className="soon-card__title">Payouts coming soon</h3>
            <p className="soon-card__body">
              Referral earnings and payouts aren&rsquo;t switched on yet. Keep sharing your
              referral link above — when a worker you referred joins and gets contacted, your
              mock rev-share will start accruing here.
            </p>
          </div>
        </section>
      ) : earnings ? (
        <>
          <EarningsPanel earnings={earnings} />
          <KycPanel kyc={kycForPanel} />
          <PayoutPanel earnings={earnings} payouts={payouts} />
        </>
      ) : null}
    </>
  );
}

/**
 * Conversion percentage for the funnel ProgressBar, computed ONLY from k-anon-cleared
 * stages. If either `created` or `clicked` was suppressed to 0 (below the floor), we
 * return null so NO exact rate is shown — a percentage over a sub-floor base could leak a
 * single-invitee signal. Clamped to 0–100.
 */
function conversionPct(summary: AgencyReferralsSummary): number | null {
  const { created, clicked } = summary;
  if (created <= 0 || clicked <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((clicked / created) * 100)));
}
