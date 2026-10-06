import { ACTION_ICON, Icon } from "@badabhai/icons";
import type { AgencyFlags } from "../../../../lib/config";
import { Badge, Card } from "../../../../components/ds";

/**
 * "NOT IN THIS RELEASE" — the agency modules that are parked, deferred, or live only as a MOCK —
 * DS3.1 re-skin onto the BadaBhai Design System (VISUAL layer only).
 *
 * Two kinds of card, by what is TRUE of the module (each tied to its public flag, all default OFF;
 * no flag logic lives here — a flag only chooses which true sentence is shown):
 *
 *  - PARKED / DEFERRED (flag off, or a module with nothing built): an informational, NON-interactive
 *    card that names the module and its gate. Matching / outcome tracking is product-locked and
 *    unbuilt, so its flag being on only re-labels it ("Flagged on — still unbuilt").
 *  - TEST MODE (KYC or Payouts with its flag on): ADR-0022 Amendment 2 (accepted 2026-07-23) BUILT
 *    both as MOCK, launch-gated modules — KYC is checked by hand (no real registry) and a payout
 *    request moves no money. They render on /agency/referrals, so the card says it is available in
 *    test mode and links there. Until this was corrected the card called them "still unbuilt".
 *
 * NOT LISTED: bulk invite upload. It is DEAD — a consent violation that will never be built
 * (ADR-0022 Amendment 3) — so it does not belong in a list of modules "not in this release",
 * where a "Parked" badge would frame it as coming. Its explanation page is reachable by its URL.
 *
 * NEVER promise payouts / ₹500 / 25% / 90d / any commercial term. The cards name the module, its
 * gate or its test-mode status ONLY.
 *
 * A parked card is the UI-1 `soon-card` primitive marked `aria-disabled` — the one visual language
 * for "not open yet": a dashed, colourless placeholder, never broken and never interactive. Its
 * status pill stays a DS `Badge` rather than the `soon-badge`, because "Soon" is precisely the
 * promise these cards must NEVER make: each is gated on a legal, money or product decision, not on
 * engineering readiness. A test-mode card is a real door, so it is the dashboard's whole-card link
 * tile instead. Tokens only (no raw hex/px).
 *
 * CLOSED BY DEFAULT (final sweep F21): this is the page's lowest-priority block; open, it was most
 * of the agency dashboard's height on a phone. The native <summary> keeps it one keypress away.
 */

interface ModuleCard {
  title: string;
  /** Why it is not here (shown while parked). */
  parkedNote: string;
  /** Whether its public flag is on. */
  flaggedOn: boolean;
  /**
   * What is true once the flag is on and the module is BUILT as a mock (ADR-0022 Amdt 2) — absent
   * for a module that is still unbuilt, whose flag only re-labels the card.
   */
  testModeNote?: string;
}

/** Where the mock KYC + payout panels render (ADR-0022 Amendment 2). */
const REFERRALS_HREF = "/agency/referrals";

export function AgencyParkedModules({ flags }: { flags: AgencyFlags }) {
  const cards: ModuleCard[] = [
    {
      title: "Payout details (KYC)",
      parkedNote: "Parked: legal/DPDP sign-off required",
      flaggedOn: flags.agencyKycEnabled,
      testModeNote:
        "Available in test mode on Referrals: details are checked by hand, not against a real registry, and no real payout is made.",
    },
    {
      title: "Payouts",
      parkedNote: "Parked: real payments + product-ratified params required",
      flaggedOn: flags.agencyPayoutsEnabled,
      testModeNote:
        "Available in test mode on Referrals: a payout request is recorded but no real payout is made.",
    },
    {
      title: "Matching / Outcome Tracking",
      parkedNote: "Deferred by product lock",
      flaggedOn: flags.agencyOutcomeTrackingEnabled,
    },
  ];

  return (
    // A native <details> (keyboard-operable for free; the caret honours reduced motion), CLOSED by
    // default. `.agency-parked-disclosure` carries this block's own bottom rhythm.
    <details className="agency-disclosure agency-parked-disclosure">
      <summary className="agency-disclosure__summary">
        <span className="section__title">Not in this release</span>
        <Icon name={ACTION_ICON.disclosure} className="agency-disclosure__caret" />
      </summary>
      <p className="section__sub">
        These modules are gated on legal, money or product decisions — not engineering readiness.
        One that is switched on runs in test mode only: no real payout is made.
      </p>
      <div className="stat-row">
        {cards.map((c) =>
          c.flaggedOn && c.testModeNote ? (
            <Card
              key={c.title}
              className="agency-stat"
              href={REFERRALS_HREF}
              ariaLabel={`${c.title} — available in test mode on Referrals`}
            >
              <div className="agency-stat__head">
                <span className="agency-stat__label">{c.title}</span>
              </div>
              <div className="agency-stat__foot">
                <Badge tone="info" upper>
                  Test mode
                </Badge>
                <span className="agency-stat__hint">
                  {c.testModeNote} <Icon name={ACTION_ICON.next} />
                </span>
              </div>
            </Card>
          ) : (
            <div key={c.title} className="soon-card" aria-disabled="true">
              <Badge tone="warning" upper>
                {c.flaggedOn ? "Flagged on — still unbuilt" : "Parked"}
              </Badge>
              <h3 className="soon-card__title">{c.title}</h3>
              <p className="soon-card__body">{c.parkedNote}</p>
            </div>
          ),
        )}
      </div>
    </details>
  );
}
