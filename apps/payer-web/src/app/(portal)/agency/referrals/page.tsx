import { notFound } from "next/navigation";
import { Icon } from "@badabhai/icons";
import { requireAgent } from "../../../../lib/auth/roles";
import { agencyFlags } from "../../../../lib/config";
import {
  getAgencyEarnings,
  getAgencyKyc,
  getAgencyReferralsSummary,
  listAgencyPayouts,
} from "../../../../lib/payer-api";
import { assertNoAgencyPII } from "../../../../lib/assert-no-agency-pii";
import { isPayerForbiddenError, isPayerStatus } from "../../../../lib/payer-errors";
import type {
  AgencyEarnings,
  AgencyKyc,
  AgencyPayout,
  AgencyReferralsSummary,
} from "../../../../lib/contracts";
import { kAnonCount } from "../../../../lib/agency-view";
import { ProgressBar, StatTile } from "../../../../components/ds";
import { PageHeader } from "../../../../components/page-header";
import { RetryButton } from "../../../../components/retry-button";
import { AgencyBatchInvitePanel } from "../dashboard/batch-invite-panel";
import { AgencyInvitePanel } from "../dashboard/invite-panel";
import { EarningsPanel } from "./earnings-panel";
import { KycPanel } from "./kyc-panel";
import { PayoutPanel } from "./payout-panel";

export const dynamic = "force-dynamic";

/**
 * Agency-only "Referrals" (ADR-0022 Amendment 2; the rail item and the H1 share the name) — the
 * agency SUPPLY-money
 * surface: a shareable referral link, the aggregate referral funnel, referral EARNINGS,
 * payout KYC, and payout requests. MOCK money (no real disbursement).
 *
 * SECURITY (role authz / XB-A): `requireAgent()` is the FIRST statement — an employer
 * session gets a NEUTRAL 404 (no oracle, no client hide) before any read runs. Every
 * server action re-asserts the gate itself. Tenancy is the SESSION (no body payer_id).
 *
 * PORTAL FLAG (2026-10-01, a behaviour change): like every sibling agency page (Worker activity,
 * QR invite, Revenue, Bulk invite upload, Postings), this page now 404s when the agency-portal
 * flag is off — it was the one Supply page that ignored it, so with the flag off the rail hid
 * its siblings while this one stayed open.
 *
 * FACELESS (CLAUDE.md §2 #2 / B-R2): the funnel is AGGREGATE-ONLY with the k-anon floor
 * applied server-side; the earnings/KYC/payout reads are amounts/counts/status + the
 * MASKED KYC last-4 only. Every payload crosses {@link assertNoAgencyPII} at the seam.
 *
 * GATE (fail-closed): while `AGENCY_PAYOUTS_ENABLED` is OFF (the default) the
 * earnings/KYC/payout routes return 404 → the seam maps that to `null` and this page
 * renders a graceful "coming soon" inert panel, NOT an error. The referral link + funnel
 * stay LIVE either way.
 *
 * OWNER-ONLY (#2178, ADR-0053 O-5): once the flag is on, a recruiter's read is refused
 * with 403 (`Org role is not permitted for this resource`). That is a neutral
 * "Only your organization's owner can see payouts" state — no retry, no error
 * styling. The server stays the authority (the 403); the session orgRole below only
 * skips the doomed reads.
 */
export default async function AgencyReferralsPage() {
  // 1) SERVER-enforced role gate — an `employer` session 404s here before any read runs.
  const session = await requireAgent();
  // 1b) Public flag fail-close, as on every sibling agency page: off → the route does not exist.
  if (!agencyFlags().agencyPortalEnabled) notFound();

  // 1c) OWNER-ONLY fast path (#2178): an explicit recruiter never sees money — skip the
  // gated reads entirely and render the neutral owner-only state below. Only an EXPLICIT
  // "recruiter" skips here (an absent/null orgRole — an older API — still tries the reads
  // and lets the server's 403/200 decide, so nothing hides on a stale session shape).
  const isExplicitRecruiter = session.orgRole === "recruiter";

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
  //    403 = recruiter on an owner-only route (#2178 → neutral owner-only, never retry);
  //    any other thrown error is a transient degrade (retry), distinct from both.
  //    `isPayerStatus(e, 403)` rides alongside `isPayerForbiddenError` so a 403 in the
  //    transport's historic message shape (a test fake, another module instance) reads
  //    the same — the status is the contract, never the class identity.
  let earnings: AgencyEarnings | null = null;
  let payoutsEnabled = true;
  let earningsError = false;
  let earningsForbidden = isExplicitRecruiter;
  if (!isExplicitRecruiter) {
    try {
      const res = await getAgencyEarnings();
      if (res === null) payoutsEnabled = false; // gated route (404) — not enabled yet.
      else earnings = res;
    } catch (e) {
      if (isPayerForbiddenError(e) || isPayerStatus(e, 403)) earningsForbidden = true;
      else earningsError = true;
    }
  }

  // 4) Only when earnings loaded do we read KYC + payout history (same gate). Each isolated.
  //    A 403 here (e.g. a demotion landing between the reads) folds back into the same
  //    neutral owner-only state rather than a form or an error — the server refused.
  let kyc: AgencyKyc | null = null;
  let payouts: AgencyPayout[] = [];
  if (earnings && payoutsEnabled && !earningsForbidden) {
    const [kycRes, payoutsRes] = await Promise.allSettled([getAgencyKyc(), listAgencyPayouts()]);
    if (kycRes.status === "fulfilled" && kycRes.value) kyc = kycRes.value;
    else if (
      kycRes.status === "rejected" &&
      (isPayerForbiddenError(kycRes.reason) || isPayerStatus(kycRes.reason, 403))
    ) {
      earningsForbidden = true;
    }
    if (payoutsRes.status === "fulfilled" && payoutsRes.value) payouts = payoutsRes.value;
    else if (
      payoutsRes.status === "rejected" &&
      (isPayerForbiddenError(payoutsRes.reason) || isPayerStatus(payoutsRes.reason, 403))
    ) {
      earningsForbidden = true;
    }
    if (earningsForbidden) {
      earnings = null;
      kyc = null;
      payouts = [];
    }
  }
  // If earnings loaded but KYC didn't come back, default to not_submitted so the form shows.
  const kycForPanel: AgencyKyc = kyc ?? {
    status: "not_submitted",
    panLast4: null,
    bankLast4: null,
    rejectReason: null,
    updatedAt: null,
  };

  // `.agency-referrals-page` only NAMESPACES this screen's layout rules (see the "AGENCY ·
  // REFERRALS & EARNINGS + WORKER ACTIVITY (W2-B polish)" block in globals.css): the two invite
  // tools are framed like the panels below them, and every block heading shares one size.
  return (
    <div className="agency-referrals-page">
      <PageHeader
        title="Referrals"
        description="Share your referral link, track your consent-safe funnel (aggregate counts, never a per-worker breakdown) and, where enabled, your mock referral earnings."
      />

      {/*
        THE LEAD PAIR (F19): the funnel, then the one primary. A layout box only — on a laptop it
        is plain block flow and changes nothing; on a phone (≤600px, globals.css) it lifts the
        invite panel above the funnel, so "Create invite link" is on the first screen (it sat at
        823-867 on a 375x812 phone, under 355px of funnel tiles). Only this pair reorders: the
        page itself stays block flow, where an earnings section's last margin still collapses.
      */}
      <div className="agency-referrals-page__lead">
        {/*
          a) REFERRAL FUNNEL — LIVE aggregate, k-anon floored (no per-invitee oracle). FIRST in the
          DOM and on every screen wider than a phone (final sweep F19): it is what the page
          reports, and above the forms it puts "Create invite link" on screen sooner than the
          forms' own fields and prose did (measured at 1280).

          A `.section` (not a `.panel`): the body is a run of StatTiles that already carry their
          own surface, so a bordered frame around them would be a box inside a box. The k-anon
          disclosure is the section's SUB — it describes the whole funnel, so it reads before the
          numbers rather than as a footnote after them.
        */}
        <section className="section">
          <div className="section__head">
            <div className="section__text">
              <h2 className="section__title">Referral funnel</h2>
              {summary && !funnelError ? (
                <p className="section__sub">
                  Aggregate only — counts below {summary.minBucket} show as &ldquo;&lt;
                  {summary.minBucket}&rdquo; to protect a single worker&rsquo;s privacy. There is no
                  per-worker breakdown.
                </p>
              ) : null}
            </div>
          </div>
          {summary && !funnelError ? (
            <>
              {/* `stat-row--kpi` (the shared opt-in): no hole beside a wrapped tile, and each
                  tile is a compact ledger row on a phone instead of a 115px card. */}
              <div className="stat-row stat-row--kpi">
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
                label="Created-to-clicked conversion"
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
                <Icon name="warning-circle" />
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

        {/* b) REFERRAL LINK — LIVE faceless mint (opaque code/link + copy; consent-first). Its
            "Create invite link" is this page's ONE primary, right under the consent note. */}
        <AgencyInvitePanel />
      </div>

      {/*
        c) BATCH MINT — the same faceless mint, N at a time (≤50) for a gate drive or a print
        run. Cardinality-shaped: the ONLY inputs are a count and one shared non-PII tag. This is
        NOT the dead "Bulk Invite Upload" (it ingests worker contacts); nothing here accepts,
        stores or sends a worker identity. The page's SECONDARY tool: a closed disclosure whose
        "Create links" is a secondary button. It owns the `#batch-invites` fragment target.
      */}
      <AgencyBatchInvitePanel />

      {/* d) SUPPLY MONEY — earnings + KYC + payout, gated behind AGENCY_PAYOUTS_ENABLED. */}
      {/* OWNER-ONLY (#2178): a recruiter's 403 is a neutral state — no retry, no error
          styling. The referral link + funnel above stay live either way. */}
      {earningsForbidden ? (
        <section className="section">
          <div className="section__head">
            <h2 className="section__title">Earnings &amp; payouts</h2>
          </div>
          <div className="state state--neutral">
            <span className="state__icon">
              <Icon name="lock-key" />
            </span>
            <h3 className="state__title">Owner only</h3>
            <p className="state__body">
              Only your organization&apos;s owner can see payouts.
            </p>
          </div>
        </section>
      ) : earningsError ? (
        <section className="section">
          <div className="section__head">
            <h2 className="section__title">Your earnings</h2>
          </div>
          <div className="state state--error">
            <span className="state__icon">
              <Icon name="warning-circle" />
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
    </div>
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
