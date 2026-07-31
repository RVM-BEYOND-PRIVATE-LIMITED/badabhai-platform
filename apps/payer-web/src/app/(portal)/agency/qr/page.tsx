import Link from "next/link";
import { requireAgent } from "../../../../lib/auth/roles";
import { agencyFlags } from "../../../../lib/config";
import { notFound } from "next/navigation";
import { Card, Badge } from "../../../../components/ds";

export const dynamic = "force-dynamic";

export default async function QrPage() {
  // Auth/role gate only — this parked shell renders no session data.
  await requireAgent();
  const flags = agencyFlags();
  if (!flags.agencyPortalEnabled) notFound();

  return (
    <>
      <p className="capacity-back">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1 className="dash-title">QR Code</h1>
      <p className="dash-sub">Generate scannable QR codes for worker invites.</p>

      <Card variant="flat" className="agency-parked__card" aria-disabled="true">
        <div className="agency-parked__head">
          <Badge tone="warning" upper>Coming soon</Badge>
        </div>
        <p className="agency-parked__note">
          QR code generation is not yet built. Workers will scan a QR code to receive the invite
          link on their phone — coming in a future release.
        </p>
      </Card>
    </>
  );
}
