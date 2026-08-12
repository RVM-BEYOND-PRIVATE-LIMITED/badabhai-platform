import type { AgencyFlags } from "../../../../lib/config";
import { Badge } from "../../../../components/ds";

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
 * Each card is the UI-1 `soon-card` primitive marked `aria-disabled` — the one visual
 * language for "not open yet": a dashed, colourless placeholder, never broken and never
 * interactive (no DS Button, no link). The status pill stays a DS `Badge` rather than the
 * `soon-badge`, because "Soon" is precisely the promise these cards must NEVER make: three
 * of the four are gated on legal/money/consent decisions and one will not be built at all.
 * Tokens only (no raw hex/px).
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
    // COMPACT-1: this verbose, lowest-priority secondary section (what is deliberately NOT
    // built) becomes an accessible native <details> disclosure to lift dashboard density —
    // but it stays `open` by DEFAULT so nothing is hidden on first paint. Layout/disclosure
    // only: the same heading, sub-copy, and parked cards render unchanged. The native
    // <summary> is keyboard-operable for free; the chevron motion honors reduced-motion.
    // `.agency-parked-disclosure` carries this block's own bottom rhythm, so the retired
    // `.agency-section` wrapper class is not replaced by anything.
    <details className="agency-parked-disclosure" open>
      <summary className="agency-parked-disclosure__summary">
        <span className="section__title">Not in this release</span>
        <i className="ph ph-caret-down agency-parked-disclosure__caret" aria-hidden="true" />
      </summary>
      <p className="section__sub">
        These modules are deliberately not built. They are gated on legal, money, consent, or
        product decisions — not engineering readiness.
      </p>
      <div className="stat-row">
        {cards.map((c) => (
          <div key={c.title} className="soon-card" aria-disabled="true">
            <Badge tone="warning" upper>
              {c.flaggedOn ? "Flagged on — still unbuilt" : "Parked"}
            </Badge>
            <h3 className="soon-card__title">{c.title}</h3>
            <p className="soon-card__body">{c.note}</p>
          </div>
        ))}
      </div>
    </details>
  );
}
