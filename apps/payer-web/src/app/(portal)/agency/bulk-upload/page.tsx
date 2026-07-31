import Link from "next/link";
import { requireAgent } from "../../../../lib/auth/roles";
import { agencyFlags } from "../../../../lib/config";
import { notFound } from "next/navigation";
import { Card, Badge } from "../../../../components/ds";

export const dynamic = "force-dynamic";

export default async function BulkUploadPage() {
  // Auth/role gate only — this parked shell renders no session data.
  await requireAgent();
  const flags = agencyFlags();
  if (!flags.agencyPortalEnabled) notFound();

  return (
    <>
      <p className="capacity-back">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1 className="dash-title">Bulk Upload</h1>
      <p className="dash-sub">Invite multiple workers at once.</p>

      <Card variant="flat" className="agency-parked__card" aria-disabled="true">
        <div className="agency-parked__head">
          <Badge tone="warning" upper>Coming soon</Badge>
        </div>
        <p className="agency-parked__note">
          Bulk upload is not yet built. Upload a file with multiple invites to onboard workers at
          scale — coming in a future release.
        </p>
      </Card>
    </>
  );
}
