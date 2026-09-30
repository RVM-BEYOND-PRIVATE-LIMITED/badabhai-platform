import { createHash } from "node:crypto";

/**
 * The origin the résumé's QR and printed short link point at.
 *
 * TWO QRs ARE BUILT ON IT, and neither is a per-worker PAGE (none exists; no PII is ever shown):
 *  - the bare origin — the homepage (owner ruling 2026-08-28). What every sheet printed while
 *    RESUME_QR_SCAN_ENABLED is off carries, and the fallback of any render whose `/r/` QR fails;
 *  - {@link resumeQrScanUrl} — `<origin>/r/<code>` of the worker's own `resume_qr` link (#1800,
 *    owner ruling 2026-09-28 "Count + attribute worker signups"). badabhai.ai 302s `/r/*` to the
 *    api's resolver, which counts the scan and 302s to the install page.
 *
 * THE HOST IS PART OF THE QR SIZE BUDGET. `https://badabhai.ai/r/<12 hex>` is a version-4 symbol
 * at level Q (33 modules, 0.545 mm at 18 mm — `sheet-qr.gate.test.ts`), and version 5 would break
 * the 0.5 mm floor, so any longer host or path must be re-measured there first. The QR names
 * badabhai.ai rather than the api's interim host by owner ruling: the printed sheet outlives the
 * Lightsail IP the api's hostname embeds, and a Netlify `/r/*` 302 can be re-pointed in minutes
 * while paper cannot be re-issued.
 *
 * `.ai`, NOT `.in`. The registered domain is badabhai.ai; 56 files still say `.in` and are a
 * separate cross-cutting rename, but nothing new should add to that pile.
 */
export const RESUME_PROFILE_ORIGIN = "https://badabhai.ai";

/**
 * The line printed under the QR. It must describe what the QR opens, because the sheet outlives
 * the render and is read by the employer holding it.
 *
 * It used to say "Scan to open this worker's live profile", which promised a per-worker page that
 * does not exist. "Scan to visit BadaBhai" is true of BOTH QRs {@link RESUME_PROFILE_ORIGIN}
 * describes: the homepage, and the `/r/<code>` variant (#1800), which lands on BadaBhai's install
 * page. If a per-worker page ever ships, this line and the target change TOGETHER.
 */
export const RESUME_QR_CAPTION = "Scan to visit BadaBhai";

/**
 * #1800 — the URL the worker's own résumé QR encodes when their `resume_qr` link exists:
 * `https://badabhai.ai/r/<code>`.
 *
 * THE CODE IS A BEARER TOKEN. It lives in the QR's modules and nowhere else on the page: the
 * printed short link stays the bare host and the caption names no code (`resume-fabrication.gate
 * .test.ts` would refuse a 12-hex run in the chrome). Percent-encoded for the same reason the
 * resolver encodes it on the way out, though a well-formed code never needs it.
 */
export function resumeQrScanUrl(code: string): string {
  return `${RESUME_PROFILE_ORIGIN}/r/${encodeURIComponent(code)}`;
}

/**
 * The `bb_trade` sheet's footer line and its reference code. PURE — the clock is an argument.
 *
 * WHY THE REF CODE EXISTS. A supervisor holding a stack of printed sheets needs one short token
 * to quote back over the phone ("bhej do RK8M2Q wala"), and support needs to find the exact
 * artifact from a photo of a page. It is on the ratified design and it earns its 6 characters.
 */

/**
 * Unambiguous in print and over a phone: no O/0, no I/1, no S/5, no Z/2, no B/8.
 *
 * THE ALPHABET IS THE WHOLE POINT. This code is read aloud on a noisy shop floor and typed by
 * someone who may be reading a photocopy. Crockford's set is the reviewed answer to exactly
 * that problem, and a plain base36 slice would put `0` and `O` side by side on a printed page.
 */
const ALPHABET = "ACDEFGHJKLMNPQRTUVWXY34679";
const REF_LENGTH = 6;

/**
 * A stable, non-PII reference for one résumé.
 *
 * DERIVED FROM THE RESUME ID BY HASH, not from anything about the worker. Two properties matter
 * and both come from that choice: it is DETERMINISTIC, so re-rendering the same résumé prints
 * the same code and a regenerated PDF is not a false diff; and it is ONE-WAY, so a code read off
 * a page a worker handed to a stranger discloses nothing and cannot be walked back to a row.
 *
 * NOT A SECURITY BOUNDARY, and must never become one. Six characters from a 26-symbol alphabet
 * is ~28 bits — fine as a human-quotable label, useless as a capability. Nothing may authorise
 * on it; the résumé download already goes through a short-TTL signed URL.
 */
export function resumeRefCode(resumeId: string): string {
  const digest = createHash("sha256").update(resumeId).digest();
  let out = "";
  for (let i = 0; i < REF_LENGTH; i += 1) {
    out += ALPHABET[digest[i]! % ALPHABET.length];
  }
  return out;
}

/**
 * "Generated 27 August 2026 · Self-declared · Ref RK8M2Q".
 *
 * SEGMENTS ARE DROPPED WITH THEIR SEPARATOR, never left dangling. The design guideline makes
 * this a rule for the Verdict Line and the same reasoning applies here: a trailing " · " on a
 * printed sheet reads as a rendering fault, and an unverified worker must not acquire an empty
 * slot where a verification tier would sit.
 *
 * THE DATE IS SPELLED OUT IN EN-GB ("27 August 2026") rather than localised. A résumé is a
 * durable artifact read months later by someone who did not generate it, and 07/08 is a
 * different day depending on who is holding the page.
 */
export function buildSheetFooterMeta(input: {
  generatedAt: Date;
  trustBadge?: string | null;
  refCode?: string | null;
  /**
   * TIERED PROFILING — "Quick profile" / "Detailed profile" / "BadaBhai Recommended profile", LAST,
   * after the ref. Absent while tiers are off, so every sheet's footer is exactly today's.
   */
  tierLabel?: string | null;
}): string {
  const date = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  }).format(input.generatedAt);
  const segments = [
    `Generated ${date}`,
    input.trustBadge?.trim() || null,
    input.refCode?.trim() ? `Ref ${input.refCode.trim()}` : null,
    input.tierLabel?.trim() || null,
  ].filter((s): s is string => Boolean(s));
  return segments.join("  ·  ");
}
