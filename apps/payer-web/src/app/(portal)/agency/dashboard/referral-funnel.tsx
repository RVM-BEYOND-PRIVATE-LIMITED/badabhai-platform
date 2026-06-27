import { kAnonCount } from "../../../../lib/agency-view";
import type { AgencyReferralsSummary } from "../../../../lib/contracts";
import { Badge, Card } from "../../../../components/ds";
import { RetryButton } from "../../../../components/retry-button";

/**
 * AGENCY REFERRAL FUNNEL (ADR-0022, LIVE) — DS3.1 re-skin onto the BadaBhai Design System
 * (VISUAL layer only). The agency's OWN invite funnel, AGGREGATE ONLY.
 *
 * The backend (`GET /payer/agency/referrals/summary`) has ALREADY applied the k-anon floor:
 * any stage count strictly below `minBucket` is returned as 0. This view renders those
 * counts AS-IS via {@link kAnonCount} — a 0 shows as "<minBucket", NEVER a literal zero —
 * so a single named invitee's consent can never be inferred (no oracle). There are NO
 * per-invitee / per-worker rows here by construction; nothing is reconstructed.
 *
 * Each stage is a DS `Card` with its k-anon count in mono tabular (`bb-mono`); the count is
 * rendered IN-CARD as a child node (never a bare 0). Tokens only.
 */
export function ReferralFunnel({ summary }: { summary: AgencyReferralsSummary | null }) {
  if (!summary) {
    return (
      <div className="agency-funnel">
        <Card className="agency-funnel__card agency-funnel__card--state">
          <h3 className="agency-funnel__label">Referral funnel</h3>
          <div className="agency-funnel__value bb-mono">—</div>
          <p className="agency-funnel__hint">
            <Badge tone="warning" upper>
              Unavailable
            </Badge>{" "}
            Could not load right now. <RetryButton />
          </p>
        </Card>
      </div>
    );
  }

  const { created, clicked, accepted, minBucket } = summary;
  // Each stage card is a whole-card link to the referrals page. The href is a static literal
  // (no per-invitee/worker id) — aggregate, k-anon counts only; faceless preserved.
  const REF = "/agency/referrals";
  return (
    <>
      <div className="agency-funnel">
        <Card className="agency-funnel__card" href={REF} ariaLabel="Invites created — view referrals">
          <h3 className="agency-funnel__label">Invites created</h3>
          <div className="agency-funnel__value bb-mono">{kAnonCount(created, minBucket)}</div>
          <p className="agency-funnel__hint">Links you minted</p>
        </Card>
        <Card className="agency-funnel__card" href={REF} ariaLabel="Clicked — view referrals">
          <h3 className="agency-funnel__label">Clicked</h3>
          <div className="agency-funnel__value bb-mono">{kAnonCount(clicked, minBucket)}</div>
          <p className="agency-funnel__hint">Opened the invite link</p>
        </Card>
        <Card className="agency-funnel__card" href={REF} ariaLabel="Accepted — view referrals">
          <h3 className="agency-funnel__label">Accepted</h3>
          <div className="agency-funnel__value bb-mono">{kAnonCount(accepted, minBucket)}</div>
          <p className="agency-funnel__hint">Joined &amp; consented</p>
        </Card>
      </div>
      <p className="agency-section__sub">
        Aggregate only — counts below {minBucket} show as &ldquo;&lt;{minBucket}&rdquo; to protect a
        single worker&rsquo;s privacy. There is no per-worker breakdown.
      </p>
    </>
  );
}
