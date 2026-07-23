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
import { Badge, Card, ProgressBar, StatTile } from "../../../../components/ds";
import { RetryButton } from "../../../../components/retry-button";
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
      <p className="agency-back">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1 className="agency-title">Referrals &amp; earnings</h1>
      <p className="agency-sub">
        Share your referral link, track your consent-safe funnel, and — where enabled — earn
        a mock rev-share when workers you referred get contacted. BadaBhai protects worker
        privacy: agencies see aggregate counts, never a per-worker breakdown.
      </p>

      {/* a) REFERRAL LINK — LIVE faceless mint (opaque code/link + copy; consent-first). */}
      <AgencyInvitePanel />

      {/* b) REFERRAL FUNNEL — LIVE aggregate, k-anon floored (no per-invitee oracle). */}
      <section className="agency-section">
        <h2 className="agency-section__title">Referral funnel</h2>
        {summary && !funnelError ? (
          <>
            <div className="agency-stats">
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

            <div className="agency-funnel__conv">
              <ProgressBar
                tone="success"
                label="Created → clicked conversion"
                value={pct ?? 0}
                showValue={pct !== null}
              />
              {pct === null && (
                <p className="agency-funnel__hint">
                  Conversion appears once both stages clear the privacy floor of{" "}
                  {summary.minBucket}.
                </p>
              )}
            </div>

            <p className="agency-section__sub">
              Aggregate only — counts below {summary.minBucket} show as &ldquo;&lt;
              {summary.minBucket}&rdquo; to protect a single worker&rsquo;s privacy. There is
              no per-worker breakdown.
            </p>
          </>
        ) : (
          <Card variant="flat" className="agency-jobs__empty">
            <Badge tone="warning" upper>
              Service unavailable
            </Badge>{" "}
            The referral funnel could not load right now. Please retry shortly. <RetryButton />
          </Card>
        )}
      </section>

      {/* c) SUPPLY MONEY — earnings + KYC + payout, gated behind AGENCY_PAYOUTS_ENABLED. */}
      {earningsError ? (
        <section className="agency-section">
          <h2 className="agency-section__title">Your earnings</h2>
          <Card variant="flat" className="agency-jobs__empty">
            <Badge tone="warning" upper>
              Service unavailable
            </Badge>{" "}
            Earnings could not load right now. Please retry shortly. <RetryButton />
          </Card>
        </section>
      ) : !payoutsEnabled ? (
        <section className="agency-section">
          <h2 className="agency-section__title">Earnings &amp; payouts</h2>
          <Card variant="flat" className="agency-parked__card" aria-disabled="true">
            <div className="agency-parked__head">
              <h3 className="agency-parked__title">Payouts coming soon</h3>
              <Badge tone="warning" upper>
                Coming soon
              </Badge>
            </div>
            <p className="agency-parked__note">
              Referral earnings and payouts aren&rsquo;t switched on yet. Keep sharing your
              referral link above — when a worker you referred joins and gets contacted, your
              mock rev-share will start accruing here.
            </p>
          </Card>
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
