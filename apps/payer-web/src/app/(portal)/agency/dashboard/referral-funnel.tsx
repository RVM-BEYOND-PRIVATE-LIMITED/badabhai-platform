import { kAnonCount } from "../../../../lib/agency-view";
import type { AgencyReferralsSummary } from "../../../../lib/contracts";

/**
 * AGENCY REFERRAL FUNNEL (ADR-0022, LIVE) — the agency's OWN invite funnel, AGGREGATE
 * ONLY. The backend (`GET /payer/agency/referrals/summary`) has ALREADY applied the
 * k-anon floor: any stage count strictly below `minBucket` is returned as 0. This view
 * renders those counts AS-IS via {@link kAnonCount} — a 0 shows as "<minBucket", NEVER a
 * literal zero — so a single named invitee's consent can never be inferred (no oracle).
 * There are NO per-invitee / per-worker rows here by construction; nothing is reconstructed.
 */
export function ReferralFunnel({ summary }: { summary: AgencyReferralsSummary | null }) {
  if (!summary) {
    return (
      <div className="cards">
        <div className="card">
          <h3>Referral funnel</h3>
          <div className="big">—</div>
          <p>
            <span className="badge badge-warn">Unavailable</span> Could not load right now.
          </p>
        </div>
      </div>
    );
  }

  const { created, clicked, accepted, minBucket } = summary;
  return (
    <>
      <div className="cards">
        <div className="card">
          <h3>Invites created</h3>
          <div className="big">{kAnonCount(created, minBucket)}</div>
          <p>
            <span className="badge badge-ok">Live</span> Links you minted
          </p>
        </div>
        <div className="card">
          <h3>Clicked</h3>
          <div className="big">{kAnonCount(clicked, minBucket)}</div>
          <p>Opened the invite link</p>
        </div>
        <div className="card">
          <h3>Accepted</h3>
          <div className="big">{kAnonCount(accepted, minBucket)}</div>
          <p>Joined &amp; consented</p>
        </div>
      </div>
      <p className="page-sub">
        Aggregate only — counts below {minBucket} show as &ldquo;&lt;{minBucket}&rdquo; to protect a
        single worker&rsquo;s privacy. There is no per-worker breakdown.
      </p>
    </>
  );
}
