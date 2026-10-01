/**
 * "Mera naam badlo" — a DETERMINISTIC reading of the worker's own words (ADR-0046 O3).
 *
 * WHY THIS EXISTS. Identity and contact are not editable in chat, and the worker must be pointed
 * at the Profile screen rather than told "samajh nahi aaya". The model is asked to say so in
 * `unsupported`, but nothing measures that it does — and the AI service drops any row aimed at a
 * section outside the six, so a row-based inference never sees one on real traffic
 * (BUG-IDENTITY-UNSUPPORTED). This check needs no model at all: it also answers correctly when
 * the AI service is down or in mock mode.
 *
 * NARROW ON PURPOSE. It is consulted only when NO row survived (a card is always the better
 * answer), and each pattern names the worker's OWN name, number or ID — "mera naam", "phone
 * number", "aadhaar number" — never a bare "naam" (a certificate or an employer has one too) and
 * never a bare "aadhaar" (`documents_ready` has an `aadhaar` slug the worker may legitimately add).
 * A miss costs the clarify line; a false hit costs a line that points at Profile. Neither writes.
 *
 * PRIVACY. Reads the message the edit handler receives — already pseudonymized, so "mera naam
 * [PERSON_1] karo" still reads "mera naam" — in process; returns a closed value; logs nothing.
 */

/** The unsupported targets this check can name — a subset of the AI contract's closed set. */
export type IdentityAsk = "identity" | "contact";

const OWN = String.raw`(?:mera|meri|mere|apna|apni|apne|my)`;
const NUMBER = String.raw`(?:no\.?|number|nambar|namber|num)`;

const IDENTITY_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\b${OWN}\s+(?:pura\s+|poora\s+|full\s+)?(?:naam|name)\b`),
  /^(?:naam|name)\b/,
  new RegExp(String.raw`\b(?:aadhaar|aadhar|adhaar|adhar|pan|voter\s*id)\s*(?:card\s*)?${NUMBER}\b`),
  /(?:मेरा|मेरी|मेरे|अपना|अपनी|अपने)\s+(?:पूरा\s+)?नाम/u,
  /^नाम/u,
  /(?:आधार|पैन)\s*(?:कार्ड\s*)?(?:नंबर|नम्बर)/u,
];

const CONTACT_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\b(?:phone|fone|mobile|mob|whatsapp|contact)\s*${NUMBER}\b`),
  new RegExp(String.raw`\b${OWN}\s+(?:phone|fone|mobile|number|nambar|email|e-mail|whatsapp)\b`),
  /\be-?mail\b/,
  // "phone badlo" — but never "mobile repairing": a bare device word needs a change verb after it.
  /^(?:phone|fone|mobile)\s+(?:badl|change|update|sahi|theek|galat)/,
  /(?:फ़ोन|फोन|मोबाइल)\s*(?:नंबर|नम्बर)/u,
  /^(?:फ़ोन|फोन|मोबाइल)\s+(?:बदल|चेंज|अपडेट)/u,
  /(?:मेरा|अपना)\s+(?:नंबर|नम्बर|ईमेल)/u,
];

/** Whether the message asks to change the worker's own name/ID or phone/email; null otherwise. */
export function identityAskIn(text: string): IdentityAsk | null {
  const normalised = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (IDENTITY_PATTERNS.some((pattern) => pattern.test(normalised))) return "identity";
  if (CONTACT_PATTERNS.some((pattern) => pattern.test(normalised))) return "contact";
  return null;
}
