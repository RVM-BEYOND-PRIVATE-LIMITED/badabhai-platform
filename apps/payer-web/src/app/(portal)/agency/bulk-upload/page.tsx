import Link from "next/link";
import { requireAgent } from "../../../../lib/auth/roles";
import { agencyFlags } from "../../../../lib/config";
import { notFound } from "next/navigation";
import { Card, Badge } from "../../../../components/ds";

export const dynamic = "force-dynamic";

/**
 * BULK INVITE UPLOAD — the honest "this does not exist" page (ADR-0022 module 2: DEAD, no
 * gate; Amendment 3). Bulk contact upload is an INBOUND ASSERTION ABOUT REAL PEOPLE who
 * never consented — it would make BadaBhai hold a contactable list before invariant #6 can
 * even be evaluated — so no flag revives it and it must never be shown as "coming soon".
 *
 * The route is KEPT (not deleted) so the dashboard tile and any bookmark land on this
 * explanation instead of a 404, and so the reader is pointed at BATCH INVITE MINTING — the
 * shipped, opposite-direction answer to the same need (anonymous links that identify nobody).
 * Names the module + its reason only; no commercial or legal language.
 */
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
      <p className="dash-sub">Bulk invite upload is not available.</p>

      <Card variant="flat" className="agency-parked__card" aria-disabled="true">
        <div className="agency-parked__head">
          <h3 className="agency-parked__title">Bulk invite upload</h3>
          <Badge tone="warning" upper>Not available</Badge>
        </div>
        <p className="agency-parked__note">
          Not available: consent violation. Uploading a list of workers&rsquo; names or phone
          numbers would mean BadaBhai holds contact details for people who have not consented.
          This is not pending a release — it will not be built.
        </p>
      </Card>

      <Card variant="flat" className="agency-parked__card">
        <div className="agency-parked__head">
          <h3 className="agency-parked__title">Inviting many workers at once</h3>
          <Badge tone="success" upper>Live</Badge>
        </div>
        <p className="agency-parked__note">
          Create <strong>batch invite links</strong> instead: BadaBhai generates several
          anonymous links that identify nobody, and each worker joins and gives their own
          consent. You upload nothing.{" "}
          <Link href="/agency/referrals#batch-invites">Create batch invite links</Link>
        </p>
      </Card>
    </>
  );
}
