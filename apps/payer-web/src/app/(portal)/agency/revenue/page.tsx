import { requireAgent } from "../../../../lib/auth/roles";
import { agencyFlags } from "../../../../lib/config";
import { notFound } from "next/navigation";
import { PageHeader } from "../../../../components/page-header";

export const dynamic = "force-dynamic";

export default async function RevenuePage() {
  // Auth/role gate only — this parked shell renders no session data.
  await requireAgent();
  const flags = agencyFlags();
  if (!flags.agencyPortalEnabled) notFound();

  return (
    <>
      <PageHeader
        title="Revenue"
        description="Earnings, payouts, and revenue analytics for your agency."
      />

      {/* The UI-1 `soon-card` — the ONE visual language for a surface that is not open yet.
          Deliberately colourless (a tint would read as a status to act on) and still
          `aria-disabled`, so this reads as a placeholder rather than a broken control. The
          copy is unchanged; the module is now named in a heading, which the primitive needs
          and which tells a reader what is missing without opening the tile it came from. */}
      <div className="soon-card" aria-disabled="true">
        <span className="soon-badge">Coming soon</span>
        <h2 className="soon-card__title">Revenue dashboard</h2>
        <p className="soon-card__body">
          Revenue dashboard is not yet built. Track your referral earnings, payout history, and
          revenue analytics here once available.
        </p>
      </div>
    </>
  );
}
