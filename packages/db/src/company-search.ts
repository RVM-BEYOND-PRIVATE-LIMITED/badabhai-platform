import { hmacSha256Hex } from "./crypto";

/**
 * Company search primitives (#2564 B10) — the ONE spelling of how a company is
 * found by name or GST without decrypting PII.
 *
 * Lives in `@badabhai/db` (the package that DEFINES the searched columns —
 * `payers.org_name_word_hashes`, `employer_profiles.gst_number_hash`) so the API
 * writers, the backfill script and any future reader share ONE implementation and
 * one token format, exactly like `crypto.ts`.
 *
 * ── WHY WORD HASHES, NOT DECRYPT-AND-FILTER ─────────────────────────────────────
 * The Companies list must search by name (whole word) across every company. The
 * names are AES ciphertext; decrypting all of them per search would spend the
 * per-admin name-egress budget (`AdminIdentityService`) and write
 * `admin.identity_viewed` audit rows for companies never displayed. Instead each
 * name is indexed once, at write time, as one keyed-HMAC digest per word — the
 * same HMAC-SHA256 + server-pepper discipline as every other lookup hash, with its
 * OWN `orgword:` domain so a word can never collide with a phone/OTP/email/org
 * digest even if the strings match. A query word hashes identically server-side;
 * Postgres matches the digest array (`@>`), never the plaintext.
 *
 * ── WHY A GST *HASH*, NOT A GST *COLUMN* ─────────────────────────────────────────
 * A GSTIN is a business identifier — looked up whole, never substring-searched.
 * The ciphertext column keeps the value; the digest keeps the lookup. Same domain
 * separation (`gst:`), same pepper, no new secret.
 */

const ORG_WORD_DOMAIN = "orgword";
const GST_DOMAIN = "gst";

/** Trim + case-fold. The STORED name keeps its casing; only hash inputs are folded. */
export function normCompanyName(name: string): string {
  return name.trim().toLowerCase();
}

/** Split a normalized name into distinct non-empty words, in first-seen order. */
export function companyNameWords(normalizedName: string): string[] {
  const seen = new Set<string>();
  for (const word of normalizedName.split(/\s+/)) {
    if (word.length > 0) seen.add(word);
  }
  return [...seen];
}

/**
 * One peppered digest per word of a company/agency display name. The input SHOULD
 * already be normalized (see {@link normCompanyName}); hashing is not normalizing,
 * and two casings of one word must hash identically.
 */
export function companyNameWordHashes(normalizedName: string, pepper: string): string[] {
  return companyNameWords(normalizedName).map((word) =>
    hmacSha256Hex(pepper, `${ORG_WORD_DOMAIN}:${word}`),
  );
}

/** The single-word query digest a company name search matches against. */
export function companySearchWordHash(word: string, pepper: string): string {
  return hmacSha256Hex(pepper, `${ORG_WORD_DOMAIN}:${normCompanyName(word)}`);
}

/** Trim, uppercase, strip internal whitespace — the canonical GSTIN form. */
export function normGstin(gstin: string): string {
  return gstin.trim().toUpperCase().replace(/\s+/g, "");
}

/** The exact-match digest for a NORMALIZED GSTIN (see {@link normGstin}). */
export function gstinHash(normalizedGstin: string, pepper: string): string {
  return hmacSha256Hex(pepper, `${GST_DOMAIN}:${normalizedGstin}`);
}
