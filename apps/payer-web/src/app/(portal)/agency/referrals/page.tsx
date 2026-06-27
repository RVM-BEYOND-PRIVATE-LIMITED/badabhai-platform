import Link from "next/link";
import { requireAgent } from "../../../../lib/auth/roles";
import { payerServerConfig } from "../../../../lib/server-config";
import { getAgencyReferralsSummary } from "../../../../lib/payer-api";
import { assertNoAgencyPII } from "../../../../lib/assert-no-agency-pii";
import { kAnonCount } from "../../../../lib/agency-view";
import type { AgencyReferralsSummary } from "../../../../lib/contracts";
import { Badge, Card, ProgressBar, StatTile } from "../../../../components/ds";
import { RetryButton } from "../../../../components/retry-button";

export const dynamic = "force-dynamic";

/**
 * Agency-only "Referrals & payouts" — DS3.2 re-skin onto the BadaBhai Design System
 * (VISUAL layer only). The FUNNEL is LIVE + AGGREGATE-ONLY; payouts/rev-share are PARKED.
 *
 * SECURITY (role authz / XB-A): `requireAgent()` is the FIRST statement — it reads the
 * SERVER-HELD signed session and returns a NEUTRAL 404 for any non-`agent` (e.g. an
 * `employer`). An employer cannot reach, read, or even confirm the existence of this
 * section. The gate is server-side off the signed session — never a client hide.
 *
 * FACELESS / AGGREGATE-ONLY (CLAUDE.md §2 #2 + #6 / B-R2 / ADR-0022 C.1 #2): the funnel
 * (`GET /payer/agency/referrals/summary`) returns COUNTS ONLY, with the k-anon floor
 * ALREADY applied server-side — any stage count strictly below `minBucket` comes back as
 * 0. {@link kAnonCount} surfaces such a 0 as "<minBucket", NEVER a literal zero, so a
 * single named invitee's consent can never be inferred (no oracle). There are NO
 * per-invitee / per-worker rows here by construction. The payload still crosses
 * {@link assertNoAgencyPII} at the render boundary (defence-in-depth; the seam wraps it
 * too). NO `payer_id` is ever sent in a request body (XB-A).
 *
 * SUPPLY PAYOUTS (referral payouts / rev-share / KYC / attribution) remain PARKED to
 * Phase 2 (CLAUDE.md §8 deferred; CEO-gated). This page builds NONE of that — no referral
 * links, no bulk invite, no referred-worker tracking, no payout dashboard, no KYC, no
 * 25%/₹500/90d attribution engine. The parked slice is a single MUTED informational DS
 * `Card`, never a broken or fake-interactive flow.
 *
 * VISUAL: the funnel renders as DS `StatTile`s (k-anon counts in mono tabular) plus a DS
 * `ProgressBar` for the created→clicked conversion (only when both stages clear the floor,
 * so the bar can never become a single-invitee oracle). The error/degrade state is a DS
 * `Card` with a neutral message + `RetryButton`. The parked slice is a muted DS `Card`.
 * Tokens only (no raw hex/px). The page holds NO form/input controls.
 */
export default async function AgencyReferralsPage() {
  // 1) SERVER-enforced role gate — an `employer` session 404s here (no oracle, no client
  //    hide), before any read runs or anything renders.
  await requireAgent();

  // Supply is fail-closed OFF by default (D2). This flag ONLY drives the parked label;
  // there is NO referral/payout/KYC code gated behind it.
  const { agencySupplyEnabled } = payerServerConfig();

  // 2) LIVE aggregate funnel read, k-anon floored server-side. Isolated so a failure
  //    degrades to a neutral retry Card rather than blanking the page.
  let summary: AgencyReferralsSummary | null = null;
  let readError = false;
  try {
    summary = assertNoAgencyPII(
      await getAgencyReferralsSummary(),
      "payer/agency/referrals/summary",
    );
  } catch {
    readError = true;
  }

  // Conversion is computed ONLY from k-anon-cleared stages — null when either base is
  // below the floor (a percentage over a sub-floor base could leak a single invitee).
  const pct = summary ? conversionPct(summary) : null;

  return (
    <>
      <p className="agency-back">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1 className="agency-title">Referrals &amp; payouts</h1>
      <p className="agency-sub">
        Your OWN invite funnel, aggregate only. BadaBhai protects worker privacy — agencies
        see consent-safe counts, never a per-worker breakdown. Payouts are a separate Phase-2
        build.
      </p>

      {/* a) REFERRAL FUNNEL — LIVE aggregate, k-anon floored (no per-invitee oracle). The DS
          primitives render INLINE here so every count/label is a direct child of the page. */}
      <section className="agency-section">
        <h2 className="agency-section__title">Referral funnel</h2>
        {summary && !readError ? (
          <>
            {/* StatTile renders its `value` in mono tabular by design (.bb-stat__value uses
                --font-mono + tabular-nums), so the k-anon count is on-brand without extra class. */}
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

      {/* b) PAYOUTS / REV-SHARE — PARKED Phase-2 (CEO-gated). A muted, non-interactive card. */}
      <section className="agency-section">
        <h2 className="agency-section__title">Referral payouts</h2>
        <Card variant="flat" className="agency-parked__card" aria-disabled="true">
          <div className="agency-parked__head">
            <h3 className="agency-parked__title">Payouts &amp; rev-share</h3>
            <Badge tone="warning" upper>
              {agencySupplyEnabled ? "Flagged on — still unbuilt" : "Parked — Phase 2 (CEO-gated)"}
            </Badge>
          </div>
          <p className="agency-parked__note">
            Coming after alpha. Referral payouts, rev-share, attribution, and KYC are
            specified but deliberately NOT built — they involve real money out, a new
            high-sensitivity PII surface (KYC), and a conversion-attribution engine (a
            CEO-gated scope decision, not an alpha feature). The agency portal today covers
            the DEMAND loop — post a vacancy, browse faceless applicants, unlock a routed
            contact, top up credits.
          </p>
        </Card>
      </section>
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
