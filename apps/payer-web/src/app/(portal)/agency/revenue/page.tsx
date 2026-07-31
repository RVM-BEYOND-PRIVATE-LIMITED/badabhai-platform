import Link from "next/link";
import { requireAgent } from "../../../../lib/auth/roles";
import { agencyFlags } from "../../../../lib/config";
import { notFound } from "next/navigation";
import { Card, Badge } from "../../../../components/ds";

export const dynamic = "force-dynamic";

export default async function RevenuePage() {
  // Auth/role gate only — this parked shell renders no session data.
  await requireAgent();
  const flags = agencyFlags();
  if (!flags.agencyPortalEnabled) notFound();

  return (
    <>
      <p className="capacity-back">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1 className="dash-title">Revenue</h1>
      <p className="dash-sub">Earnings, payouts, and revenue analytics for your agency.</p>

      <Card variant="flat" className="agency-parked__card" aria-disabled="true">
        <div className="agency-parked__head">
          <Badge tone="warning" upper>Coming soon</Badge>
        </div>
        <p className="agency-parked__note">
          Revenue dashboard is not yet built. Track your referral earnings, payout history, and
          revenue analytics here once available.
        </p>
      </Card>
    </>
  );
}
