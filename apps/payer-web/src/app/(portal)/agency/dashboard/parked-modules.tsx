import type { AgencyFlags } from "../../../../lib/config";
import { Badge, Card } from "../../../../components/ds";

/**
 * PARKED / DEAD / DEFERRED module cards (informational, NON-interactive) — DS3.1 re-skin
 * onto the BadaBhai Design System (VISUAL layer only).
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
 *
 * Each card is a MUTED DS `Card` (variant `flat`) marked `aria-disabled` — clearly a
 * coming-soon/post-alpha placeholder, never broken and never interactive (no DS Button,
 * no link). Tokens only (no raw hex/px).
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
    <section className="agency-section">
      <h2 className="agency-section__title">Not in this release</h2>
      <p className="agency-section__sub">
        These modules are deliberately not built. They are gated on legal, money, consent, or
        product decisions — not engineering readiness.
      </p>
      <div className="agency-parked">
        {cards.map((c) => (
          <Card key={c.title} variant="flat" className="agency-parked__card" aria-disabled="true">
            <div className="agency-parked__head">
              <h3 className="agency-parked__title">{c.title}</h3>
              <Badge tone="warning" upper>
                {c.flaggedOn ? "Flagged on — still unbuilt" : "Parked"}
              </Badge>
            </div>
            <p className="agency-parked__note">{c.note}</p>
          </Card>
        ))}
      </div>
    </section>
  );
}
