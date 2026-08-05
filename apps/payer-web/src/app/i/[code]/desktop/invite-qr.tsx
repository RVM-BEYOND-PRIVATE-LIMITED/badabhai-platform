"use client";

import { QRCodeSVG } from "qrcode.react";

/**
 * The desktop landing page's QR — the "scan this with your phone" bridge (B4).
 *
 * A CLIENT COMPONENT, and confined to this route segment on purpose. `qrcode.react` computes
 * the matrix with React hooks, so it cannot render in a Server Component; importing it into
 * the shared `/i/[code]` route would ship its bundle to the mobile path too, breaking that
 * page's deliberate zero-client-JavaScript guarantee for a ₹7k phone on 3G. Desktop visitors
 * are not that audience, so the cost lands where the capability is used and nowhere else.
 *
 * WHAT IS ENCODED: the short link and nothing else — the same discipline as the agency's
 * printable QR sheet. No payer id, no session, no campaign, no caption rides inside the
 * matrix. Rendered locally as SVG; no third-party QR image service is ever contacted, which
 * would otherwise hand a live bearer token to an outside party for no benefit.
 */
export function InviteQr({ url }: { url: string }) {
  return (
    <QRCodeSVG
      value={url}
      size={220}
      // Level Q (25% recovery) — a screen-displayed code is photographed at an angle, often
      // off a glossy monitor. M is the floor; Q is the margin that keeps it readable.
      level="Q"
      // Four modules of quiet zone (the spec minimum). Without it scanners fail against a
      // dark page background.
      marginSize={4}
      title="Scan to install BadaBhai"
    />
  );
}
