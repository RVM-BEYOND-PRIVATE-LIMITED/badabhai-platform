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
import { ProgressBar } from "../../../../components/ds";
import { PageHeader } from "../../../../components/page-header";
import { PortalLink } from "../../../../components/portal-link";
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
        title="Referral Funnel & Worker Onboarding"
        badge={<span className="dash-workspace-badge">Live Pipeline</span>}
        description="Share consent-safe invite links, track candidate conversions, and manage partner payouts without PII liability."
        actionsSlot={
          <span className="agency-protected">
            <Icon name="shield-check" /> Consent-First Protected
          </span>
        }
      />

      {/* Stage cards — the funnel's three k-anon stages, designr7. */}
      {summary && !funnelError ? (
        <>
          <div className="agency-stages agency-stages--lg">
            <div className="agency-stage-card">
              <div className="agency-stage-card__head">
                <span>STAGE 01 · INVITES CREATED</span>
                <span className="agency-stage-card__icon">
                  <Icon name="link" />
                </span>
              </div>
              <strong className="bb-mono">
                {kAnonCount(summary.created, summary.minBucket)}
              </strong>
              <em>active tokens</em>
              <div className="agency-stage-card__foot">Tracked by agency</div>
            </div>
            <div className="agency-stage-card">
              <div className="agency-stage-card__head">
                <span>STAGE 02 · CLICKED &amp; VIEWED</span>
                <span className="agency-stage-card__icon">
                  <Icon name="cursor-click" />
                </span>
              </div>
              <strong className="bb-mono">
                {kAnonCount(summary.clicked, summary.minBucket)}
              </strong>
              <em>landing agents</em>
              <div className="agency-stage-card__foot">Workers accessed join</div>
            </div>
            <div className="agency-stage-card">
              <div className="agency-stage-card__head">
                <span>STAGE 03 · ACCEPTED &amp; CONSENT GIVEN</span>
                <span className="agency-stage-card__icon agency-stage-card__icon--green">
                  <Icon name="seal-check" />
                </span>
              </div>
              <strong className="bb-mono">
                {kAnonCount(summary.accepted, summary.minBucket)}
              </strong>
              <em>ready to deploy</em>
              <div className="agency-stage-card__foot">Self-selected on BadaBhai</div>
            </div>
          </div>

          <div className="agency-privacy-banner">
            <Icon name="info" />
            <p>
              <strong>Aggregate only:</strong> counts below {summary.minBucket} display as
              &ldquo;&lt;{summary.minBucket}&rdquo; to strictly protect single worker privacy.
              Conversion percentage metrics unlock once counts exceed {summary.minBucket}.
            </p>
            <span className="agency-protected">Privacy floor active</span>
          </div>

          {pct !== null ? (
            <div className="agency-conversion">
              <ProgressBar
                tone="success"
                label="Created-to-clicked conversion"
                value={pct}
                showValue
              />
            </div>
          ) : null}
        </>
      ) : (
        <div className="state state--error">
          <span className="state__icon">
            <Icon name="warning-circle" />
          </span>
          <h3 className="state__title">Referral funnel unavailable</h3>
          <p className="state__body">
            Your funnel counts could not load right now. Nothing has changed — your invites and
            referrals are safe. Please retry shortly.
          </p>
          <div className="state__actions">
            <RetryButton />
          </div>
        </div>
      )}

      <div className="agency-referrals-grid">
        <div className="agency-referrals-main">
          <AgencyInvitePanel />
        </div>

        <aside className="agency-referrals-side">
          {earningsForbidden ? (
            <section className="panel agency-earnings-card">
              <div className="panel__head">
                <h2 className="panel__title">Earnings &amp; Rev-Share Payouts</h2>
                <span className="soon-badge">Owner only</span>
              </div>
              <div className="panel__body">
                <p className="agency-earnings-card__lead">
                  Only your organization&rsquo;s owner can see payouts.
                </p>
              </div>
            </section>
          ) : earningsError ? (
            <section className="panel agency-earnings-card">
              <div className="panel__head">
                <h2 className="panel__title">Earnings &amp; Rev-Share Payouts</h2>
              </div>
              <div className="panel__body">
                <div className="state state--error">
                  <span className="state__icon">
                    <Icon name="warning-circle" />
                  </span>
                  <h3 className="state__title">Earnings unavailable</h3>
                  <p className="state__body">
                    Your earnings could not load right now. Anything you have accrued is still
                    there. Please retry shortly.
                  </p>
                  <div className="state__actions">
                    <RetryButton />
                  </div>
                </div>
              </div>
            </section>
          ) : !payoutsEnabled ? (
            <section className="panel agency-earnings-card">
              <div className="panel__head">
                <h2 className="panel__title">Earnings &amp; Rev-Share Payouts</h2>
                <span className="soon-badge">Soon</span>
              </div>
              <div className="panel__body">
                <p className="agency-earnings-card__lead">
                  Referral payouts aren&rsquo;t switched on yet. When active, every candidate
                  referred who gets verified and deployed unlocks rev-share.
                </p>
                <div className="agency-earnings-tier">
                  <span>Estimated Reward Tier</span>
                  <strong>Tier set at launch</strong>
                </div>
                <p className="agency-earnings-card__hint">
                  Tier is calculated automatically based on fulfillment demand.
                </p>
              </div>
              <div className="dash-panel__foot">
                <span>Payout ledger in sandbox mode</span>
                <span className="dash-panel__footend">Get Notified</span>
              </div>
            </section>
          ) : earnings ? (
            <EarningsPanel earnings={earnings} />
          ) : null}

          <section className="panel agency-dispatch">
            <div className="panel__head">
              <h2 className="panel__title">Instant Worker Dispatch Channels</h2>
            </div>
            <div className="panel__body">
              <div className="agency-dispatch-grid">
                <a className="agency-dispatch__tile" href="#invite">
                  <span className="agency-dispatch__icon">
                    <Icon name="whatsapp-logo" />
                  </span>
                  <strong>WhatsApp</strong>
                  <em>Send Invites</em>
                </a>
                <PortalLink
                  className="agency-dispatch__tile"
                  href="/agency/qr"
                  pendingLabel="QR invite"
                >
                  <span className="agency-dispatch__icon">
                    <Icon name="qr-code" />
                  </span>
                  <strong>QR Poster</strong>
                  <em>Print &amp; Post</em>
                </PortalLink>
                <a className="agency-dispatch__tile" href="#batch-invites">
                  <span className="agency-dispatch__icon">
                    <Icon name="paper-plane-tilt" />
                  </span>
                  <strong>SMS Broadcast</strong>
                  <em>Send to Database</em>
                </a>
              </div>
            </div>
          </section>
        </aside>
      </div>

      <AgencyBatchInvitePanel />

      {earnings && payoutsEnabled && !earningsForbidden ? (
        <>
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
