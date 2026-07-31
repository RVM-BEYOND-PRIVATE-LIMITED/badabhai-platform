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
      <p className="capacity-back">
        <Link href="/dashboard">← Dashboard</Link>
      </p>
      <h1 className="dash-title">QR invite</h1>
      <p className="dash-sub">
        Create an invite link as a QR code, then print it and put it up where workers already
        are — a gate, a canteen, a chai stall. Workers scan it and join themselves.
      </p>

      <AgencyQrInvite />
    </>
  );
}
