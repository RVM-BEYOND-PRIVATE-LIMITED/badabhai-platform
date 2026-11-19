/**
 * GSTIN checks (#2749 part 4) — PURE. A GSTIN is 15 characters:
 *
 *   SS PPPPPPPPPP E Z C
 *   │  │          │ │ └ check character (mod-36 checksum over the first 14)
 *   │  │          │ └── always `Z` today
 *   │  │          └──── entity number within the PAN (1-9, then A-Z)
 *   │  └─────────────── the holder's PAN (5 letters, 4 digits, 1 letter)
 *   └────────────────── the state code
 *
 * Callers normalise first (upper-case, no spaces: {@link normalizeGstinInput}). Never log or emit
 * a GSTIN: these functions return booleans and codes only.
 */

/** The 15-character shape (the same pattern as the admin company record's `GstinSchema`). */
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const BASE = CHARSET.length; // 36

/** Upper-case and drop every whitespace character (what a company may paste). */
export function normalizeGstinInput(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

/**
 * The check character for the first 14 characters of a GSTIN (the GSTN mod-36 scheme): each
 * character's value is multiplied by 1 and 2 alternately, each product is folded (quotient +
 * remainder by 36), the folds are summed, and the check is (36 − sum mod 36) mod 36.
 */
export function gstinCheckCharacter(first14: string): string {
  if (first14.length !== 14) throw new RangeError("a GSTIN check needs exactly 14 characters");
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const value = CHARSET.indexOf(first14.charAt(i));
    if (value < 0) throw new RangeError("a GSTIN holds only digits and capital letters");
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / BASE) + (product % BASE);
  }
  return CHARSET.charAt((BASE - (sum % BASE)) % BASE);
}

/** True when `gstin` (already normalised) has the GSTIN shape AND its check character is right. */
export function isValidGstin(gstin: string): boolean {
  if (!GSTIN_PATTERN.test(gstin)) return false;
  return gstinCheckCharacter(gstin.slice(0, 14)) === gstin.charAt(14);
}

/** The state code a GSTIN was registered in: its first two digits. */
export function gstinStateCode(gstin: string): string {
  return gstin.slice(0, 2);
}
