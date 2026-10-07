import { ACTION_ICON, Icon } from "@badabhai/icons";
import type { AgencyFlags } from "../../../../lib/config";
import { Badge, Card } from "../../../../components/ds";

/**
 * "NOT IN THIS RELEASE" — the agency modules that are parked or deferred, and the two that are
 * built but switched on per environment — DS3.1 re-skin onto the BadaBhai Design System.
 *
 * Two kinds of card, by what is TRUE of the module (no flag logic lives here — the inputs only
 * choose which true sentence is shown):
 *
 *  - AVAILABLE (Payout details (KYC), Payouts): ADR-0022 Amendment 2 BUILT both, with simulated
 *    payouts, behind the SERVER flag `AGENCY_PAYOUTS_ENABLED`. /agency/referrals draws their panels
 *    exactly when the earnings read answers (a 404 means off), so `payoutsAvailable` is that same
 *    answer, read by the dashboard (review M1). Only then does the card say they are available and
 *    link to Referrals. The public `NEXT_PUBLIC_ENABLE_AGENCY_KYC/PAYOUTS` flags gate nothing those
 *    panels do, so they never make that claim (they used to: the card promised a panel Referrals
 *    then did not draw).
 *  - PARKED / DEFERRED (everything else, and KYC/Payouts while the server says off or its read
 *    failed): an informational, NON-interactive card naming the module and its gate. Matching /
 *    outcome tracking is product-locked and unbuilt, so its public flag only re-labels it
 *    ("Flagged on — still unbuilt").
 *
 * NOT LISTED: bulk invite upload. It is DEAD — a consent violation that will never be built
 * (ADR-0022 Amendment 3) — so it does not belong in a list of modules "not in this release",
 * where a "Parked" badge would frame it as coming. Its explanation page is reachable by its URL.
 *
 * NEVER promise payouts / ₹500 / 25% / 90d / any commercial term, and never call KYC a "test":
 * details entered there are stored (encrypted, ADR-0022 Amdt 2) — only the payouts are simulated.
 *
 * A parked card is the UI-1 `soon-card` primitive marked `aria-disabled` — the one visual language
 * for "not open yet": a dashed, colourless placeholder, never broken and never interactive. Its
 * status pill stays a DS `Badge` rather than the `soon-badge`, because "Soon" is precisely the
 * promise these cards must NEVER make: each is gated on a legal, money or product decision, not on
 * engineering readiness. An available card is a real door, so it is the dashboard's whole-card
 * link tile instead. Tokens only (no raw hex/px).
 *
 * CLOSED BY DEFAULT (final sweep F21): this is the page's lowest-priority block; open, it was most
 * of the agency dashboard's height on a phone. The native <summary> keeps it one keypress away.
 */

interface ModuleCard {
  title: string;
  /** Why it is not here (shown while parked). */
  parkedNote: string;
  /** Available now (the server answered for a built module) — a linked card, not a parked one. */
  available: boolean;
  /** A public flag that only RE-LABELS a still-unbuilt module. */
  flaggedOn?: boolean;
}

/** Where the KYC + payout panels render (ADR-0022 Amendment 2). */
const REFERRALS_HREF = "/agency/referrals";
const AVAILABLE_NOTE = "Available on Referrals — payouts are simulated; no money is paid out yet.";

export function AgencyParkedModules({
  flags,
  payoutsAvailable,
}: {
  flags: AgencyFlags;
  /**
   * The SERVER's answer: the agency earnings read returned (`AGENCY_PAYOUTS_ENABLED` on) — the same
   * check /agency/referrals makes before it draws the KYC, earnings and payout panels. A failed
   * read is `false` (the cards stay parked, never an error).
   */
  payoutsAvailable: boolean;
}) {
  const cards: ModuleCard[] = [
    {
      title: "Payout details (KYC)",
      parkedNote: "Parked: legal/DPDP sign-off required",
      available: payoutsAvailable,
    },
    {
      title: "Payouts",
      parkedNote: "Parked: real payments + product-ratified params required",
      available: payoutsAvailable,
    },
    {
      title: "Matching / Outcome Tracking",
      parkedNote: "Deferred by product lock",
      available: false,
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
        Where payouts are switched on they are simulated: no money is paid out yet.
      </p>
      <div className="stat-row">
        {cards.map((c) =>
          c.available ? (
            <Card
              key={c.title}
              className="agency-stat"
              href={REFERRALS_HREF}
              ariaLabel={`${c.title} — available on Referrals`}
              pendingLabel="Referrals"
            >
              <div className="agency-stat__head">
                <span className="agency-stat__label">{c.title}</span>
              </div>
              <div className="agency-stat__foot">
                <Badge tone="info" upper>
                  Available
                </Badge>
                <span className="agency-stat__hint">
                  {AVAILABLE_NOTE} <Icon name={ACTION_ICON.next} />
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
