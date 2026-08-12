import Link from "next/link";
import { requireAgent } from "../../../../lib/auth/roles";
import { agencyFlags } from "../../../../lib/config";
import { notFound } from "next/navigation";

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
      <p className="page-back">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <div className="page-head">
        <div className="page-head__text">
          <h1 className="page-head__title">Bulk Upload</h1>
          <p className="page-head__sub">Bulk invite upload is not available.</p>
        </div>
      </div>

      {/*
        Both blocks are the UI-1 `alert` primitive, which is the DS replacement for the
        "flat Card + uppercase Badge + paragraph" this page used to build by hand. The
        uppercase status Badge is now the alert's TONE SPINE (warning = will not be built,
        success = shipped and live); the wording that carries the meaning is unchanged, and
        "Not available: consent violation" still leads the copy verbatim so the reason — not
        a release date — is the first thing read.
      */}
      <div className="alert alert--warning">
        <i className="ph ph-prohibit alert__icon" aria-hidden="true" />
        <div className="alert__text">
          <p className="alert__title">Bulk invite upload</p>
          <p className="alert__body">
            Not available: consent violation. Uploading a list of workers&rsquo; names or phone
            numbers would mean BadaBhai holds contact details for people who have not
            consented. This is not pending a release — it will not be built.
          </p>
        </div>
      </div>

      <div className="alert alert--success">
        <i className="ph ph-link alert__icon" aria-hidden="true" />
        <div className="alert__text">
          <p className="alert__title">Inviting many workers at once</p>
          <p className="alert__body">
            Create <strong>batch invite links</strong> instead: BadaBhai generates several
            anonymous links that identify nobody, and each worker joins and gives their own
            consent. You upload nothing.
          </p>
        </div>
        <div className="alert__actions">
          <Link
            className="bb-btn bb-btn--secondary bb-btn--sm"
            href="/agency/referrals#batch-invites"
          >
            Create batch invite links
          </Link>
        </div>
      </div>
    </>
  );
}
