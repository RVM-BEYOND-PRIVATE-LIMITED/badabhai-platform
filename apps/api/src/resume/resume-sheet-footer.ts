import { createHash } from "node:crypto";

/**
 * Where the résumé's QR and short link point, TODAY.
 *
 * THE SITE ROOT, NOT A PER-WORKER PAGE — owner ruling 2026-08-28. `/w/<code>` is Phase 3 and
 * does not exist; a QR resolving to a 404 is strictly worse on paper than one resolving to the
 * homepage, because the sheet outlives the render and cannot be re-issued once it is in an
 * employer's stack. When that page ships this constant is the only thing that changes.
 *
 * `.ai`, NOT `.in`. The registered domain is badabhai.ai; 56 files still say `.in` and are a
 * separate cross-cutting rename, but nothing new should add to that pile.
 */
export const RESUME_PROFILE_ORIGIN = "https://badabhai.ai";

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
  ].filter((s): s is string => Boolean(s));
  return segments.join("  ·  ");
}
