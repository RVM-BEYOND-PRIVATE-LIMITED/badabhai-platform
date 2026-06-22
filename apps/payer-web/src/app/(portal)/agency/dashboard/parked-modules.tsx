import type { AgencyFlags } from "../../../../lib/config";

/**
 * PARKED / DEAD / DEFERRED module cards (informational, NON-interactive).
 *
 * These are NOT clickable fake flows — they explain WHY a module is unavailable and
 * tie to the respective public flag (all default OFF). Building any of them is a
 * STOP+escalate (CLAUDE.md §8 + the agency ADRs): KYC needs legal/DPDP sign-off;
 * payouts need TD34 real payments + product-ratified params; bulk invite upload is a
 * consent violation (DEAD, never built); matching/outcome tracking is product-locked.
 *
 * NEVER promise payouts / ₹500 / 25% / 90d / any commercial term. The cards name the
 * module + its gate ONLY. A flag being ON would still build NOTHING — it only changes
 * the wording from "Parked" to "flagged on but unbuilt".
 */

interface ParkedCard {
  title: string;
  note: string;
  /** Whether the flag is on. ON never builds the flow — it only re-labels. */
  flaggedOn: boolean;
}

export function AgencyParkedModules({ flags }: { flags: AgencyFlags }) {
  const cards: ParkedCard[] = [
    {
      title: "KYC",
      note: "Parked: legal/DPDP sign-off required",
      flaggedOn: flags.agencyKycEnabled,
    },
    {
      title: "Payouts",
      note: "Parked: real payments + product-ratified params required",
      flaggedOn: flags.agencyPayoutsEnabled,
    },
    {
      title: "Bulk Invite Upload",
      note: "Not available: consent violation",
      flaggedOn: flags.agencyBulkUploadEnabled,
    },
    {
      title: "Matching / Outcome Tracking",
      note: "Deferred by product lock",
      flaggedOn: flags.agencyOutcomeTrackingEnabled,
    },
  ];

  return (
    <section className="section">
      <h2>Not in this release</h2>
      <p className="page-sub">
        These modules are deliberately not built. They are gated on legal, money, consent, or
        product decisions — not engineering readiness.
      </p>
      <div className="cards">
        {cards.map((c) => (
          <div key={c.title} className="card" aria-disabled="true" style={{ opacity: 0.7 }}>
            <h3>{c.title}</h3>
            <p>
              <span className="badge badge-warn">
                {c.flaggedOn ? "Flagged on — still unbuilt" : "Parked"}
              </span>
            </p>
            <p>{c.note}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
