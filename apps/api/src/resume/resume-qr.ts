import QRCode from "qrcode";

/**
 * The résumé footer's QR, as a self-contained `data:` URI.
 *
 * WHY IT IS GENERATED SERVER-SIDE IN NODE. `qrcode.react` is what payer-web and admin-web use,
 * and it is a React component — unreachable from a Nest worker. More importantly the résumé
 * renderer is offline by contract: WeasyPrint blocks on a remote fetch, and a template that
 * pulled a QR from a service would make every PDF depend on that service being up. The image has
 * to be IN the HTML, so it is built here and passed through the `{{#qr}}` slot.
 *
 * SVG, NOT PNG, AND THAT IS A PRINT DECISION. A QR is scanned off paper at a factory gate,
 * frequently from a photocopy. A raster QR is resampled twice — once by WeasyPrint into the page
 * and again by the copier — and its module edges soften until a phone camera stops locking on.
 * SVG rasterises once, at the printer's own resolution, at whatever size the layout asks for.
 * It is also about a third of the bytes, which matters against the 300 KB budget for a file whose
 * whole purpose is being forwarded on WhatsApp over a metered connection.
 */

/**
 * Error correction level Q — 25% of the symbol can be damaged and still decode.
 *
 * MATCHES THE AGENCY INVITE QR already in payer-web, deliberately: these are the same artifact
 * class (a printed code a stranger scans once) and they should degrade the same way. Q rather
 * than the L default because this one gets folded, photocopied and handled on a shop floor,
 * and rather than H because H inflates the module count enough to hurt at 18 mm.
 */
const ERROR_CORRECTION = "Q" as const;

/** The printed size the template reserves. Kept here so the margin can be reasoned about. */
const RENDERED_MM = 18;

/**
 * Build the QR for one worker's profile link.
 *
 * RETURNS NULL RATHER THAN THROWING. The QR is the acquisition loop, not the résumé: a worker
 * whose sheet renders without it still has a résumé, and a worker whose render job died because
 * an encoder rejected a URL has nothing. Both call sites treat null as "no QR" and the template
 * collapses the `{{#qr}}` region, so the footer text still prints.
 */
export async function buildResumeQrDataUri(url: string): Promise<string | null> {
  const target = url.trim();
  if (target.length === 0) return null;
  try {
    const svg = await QRCode.toString(target, {
      type: "svg",
      errorCorrectionLevel: ERROR_CORRECTION,
      // ZERO QUIET ZONE HERE BECAUSE THE LAYOUT SUPPLIES ONE. The spec's 4-module margin is
      // real and a code without it fails to scan — but `qrcode` would bake it into the SVG's
      // own viewBox, so it would shrink the modules INSIDE the 18 mm the template reserves
      // rather than adding space around them. The footer is white with generous padding on
      // every side of the image, which is the same quiet zone at full module size.
      margin: 0,
    });
    // `encodeURIComponent` rather than base64: an SVG data URI stays human-inspectable in the
    // rendered HTML, and the escaped form is smaller than base64 for XML. `#` MUST be escaped
    // or the parser truncates the URI at the first colour literal.
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  } catch {
    return null;
  }
}

export const RESUME_QR = { ERROR_CORRECTION, RENDERED_MM } as const;
