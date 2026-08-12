import Link from "next/link";
import { requireAgent } from "../../../../lib/auth/roles";
import { agencyFlags } from "../../../../lib/config";
import { notFound } from "next/navigation";
import { AgencyQrInvite } from "./qr-invite";

export const dynamic = "force-dynamic";

/**
 * Agency QR invite page (ADR-0022) — mint one opaque invite link and render it as a
 * PRINTABLE QR sheet.
 *
 * SECURITY (role authz / XB-A): `requireAgent()` is the FIRST statement — an employer
 * session gets the SAME neutral 404 as an unknown route (no oracle, no client-side hide),
 * and the portal flag gate stays fail-closed. The mint itself is the existing
 * `createInviteAction`, which re-asserts the agent gate itself; this page adds NO backend
 * endpoint.
 *
 * FACELESS: this page renders NO session data and NO worker data. The sheet carries only an
 * opaque code that identifies nobody — see qr-invite.tsx for what is (and is not) encoded.
 */
export default async function QrPage() {
  await requireAgent();
  const flags = agencyFlags();
  if (!flags.agencyPortalEnabled) notFound();

  return (
    <>
      <p className="page-back">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      {/*
        PRINT COUPLING (do not "clean up" the second class). The poster's print block in
        globals.css strips the on-screen furniture BY NAME once a sheet exists
        (`body:has(.agency-qr__sheet) .page-back, … .dash-title, .dash-sub { display:none }`).
        The heading and its one-line purpose are on the UI-1 page-head primitives; the legacy
        `dash-sub` token rides along on the WRAPPER purely as that print hook, so the whole
        head (title, sub AND its section-gap margin) leaves the paper exactly as it did
        before. It changes nothing on screen: every property `.dash-sub` sets (colour,
        font-size, margin-bottom) is re-declared later in the sheet by `.page-head` /
        `.page-head__title` / `.page-head__sub`, which win the cascade. Dropping it would
        print "QR invite" and this paragraph across the top of the wall poster.
      */}
      <div className="page-head dash-sub">
        <div className="page-head__text">
          <h1 className="page-head__title">QR invite</h1>
          <p className="page-head__sub">
            Create an invite link as a QR code, then print it and put it up where workers
            already are — a gate, a canteen, a chai stall. Workers scan it and join themselves.
          </p>
        </div>
      </div>

      <AgencyQrInvite />
    </>
  );
}
