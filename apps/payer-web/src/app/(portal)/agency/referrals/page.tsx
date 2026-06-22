import { requireAgent } from "../../../../lib/auth/roles";
import { payerServerConfig } from "../../../../lib/server-config";

export const dynamic = "force-dynamic";

/**
 * Agency-only "Referrals & payouts" — STATIC, NON-INTERACTIVE, PARKED note.
 *
 * SUPPLY (referral funnel + payouts) is PARKED to Phase 2 (CLAUDE.md §8 deferred:
 * payouts/payments/agency flows). This page builds NOTHING of supply: no referral
 * links, no bulk invite, no referred-worker tracking, no payout dashboard, no KYC,
 * no 25%/₹500/90d attribution engine. It is a single informational panel that
 * LINKS the already-written parked spec. Building any of the above pulls a parked,
 * backend-heavy slice (attribution + KYC + real payouts) forward — a CEO-only call.
 *
 * SECURITY (role authz / XB-A): `requireAgent()` reads the SERVER-HELD signed
 * session and returns a NEUTRAL 404 for any non-`agent` (e.g. an `employer`). An
 * employer cannot reach, read, or even confirm the existence of this section. The
 * gate is server-side off the signed session — never a client hide.
 */
export default async function AgencyReferralsPage() {
  // Server-enforced: an `employer` session 404s here (no oracle, no client hide).
  await requireAgent();

  // Supply is fail-closed OFF by default (D2). This flag ONLY drives the parked label;
  // there is NO referral/payout/KYC code gated behind it.
  const { agencySupplyEnabled } = payerServerConfig();

  return (
    <>
      <h1 className="page-title">Referrals &amp; payouts</h1>
      <p className="page-sub">
        <span className="badge badge-warn">Parked — Phase 2 (CEO-gated)</span>{" "}
        {agencySupplyEnabled
          ? "Agency referral payouts are flagged on but still unbuilt — no functionality ships in this preview."
          : "Agency referral payouts are not part of this preview."}
      </p>

      <div className="note warn">
        <strong>Not built in this release.</strong> The agency portal today covers the{" "}
        <strong>DEMAND</strong> loop only — post a vacancy, browse faceless applicants, unlock a
        routed contact, and top up credits — exactly the same flow a company uses. Referring
        candidates for a <strong>payout</strong> (the SUPPLY side) is a separate Phase-2 build.
      </div>

      <section className="section">
        <h2>What&rsquo;s parked for Phase 2</h2>
        <p className="page-sub">
          The referral funnel, payout ledger, attribution, and KYC are specified but deliberately
          NOT built. They involve real money out, a new high-sensitivity PII surface (KYC), and a
          conversion-attribution engine — a CEO-gated scope decision, not an alpha feature.
        </p>
        <p className="page-sub">
          Specification (parked, capture-only):{" "}
          <span className="mono">docs/sprint-plans/phase-2-agency-referral-payouts.md</span>
        </p>
      </section>
    </>
  );
}
