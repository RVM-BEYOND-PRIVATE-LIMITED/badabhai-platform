/**
 * R32 — redact the worker's OWN, KNOWN name out of free text before it leaves the
 * API for the ai-service.
 *
 * WHY THIS SHAPE, AND THE APPROACH THAT WAS MEASURED DEAD.
 * The obvious fix for "a worker's name reaches LLM input" is to teach the
 * pseudonymization gateway to RECOGNISE Indian names (a gazetteer + wider cue
 * regexes). That was built and measured with 487 probes: 348 still leaked —
 * regional names, Devanagari/Tamil script, fullwidth Latin, zero-width joiners and
 * diacritics all defeated it — while the widened cues newly MASKED real trade
 * vocabulary ("Wire EDM", "Jyoti CNC", "Kiran brand") and BLOCKED a legitimate turn
 * ("ITI fitter 2018-2020 kiya"). It is reverted. Do NOT reintroduce a name
 * gazetteer or broaden the ai-service's name heuristics — that direction is closed.
 *
 * This helper does the opposite and only what is actually knowable: it redacts the
 * ONE name we already hold. `workers.full_name` is decrypted server-side in apps/api
 * for `renderWorkerName` (AI-PERSONA-2), so at the egress point the caller has the
 * exact string to remove. No guessing, no gazetteer, no script coverage problem —
 * whatever the worker's name is written in, we are matching the stored value.
 *
 * WHY IT LIVES IN apps/api AND NOT THE ai-service. The ai-service must keep never
 * holding a real name; that is the existing AI-PERSONA-2 architecture (the vocative
 * crosses the boundary as the literal `{{worker_name}}` token and is interpolated
 * back only in the API's client-facing return). Shipping the name INTO the
 * ai-service so it could redact there would invert that property. So the redaction
 * happens on this side, before the hop.
 *
 * THIS IS DEFENCE IN DEPTH, NOT A REPLACEMENT GATE. The ai-service's
 * `pseudonymize()` still runs fail-closed in front of every LLM call (invariant #3).
 * This narrows one class it provably cannot catch; it does not license removing
 * anything downstream.
 *
 * ACCEPTED TRADEOFF (deliberate, not an oversight): a worker whose own name collides
 * with trade vocabulary loses that token. A worker actually named "Kiran" who writes
 * "Kiran brand ka machine" gets "[NAME] brand ka machine"; a worker named "Steel"
 * loses "steel". The collision is bounded to that ONE worker's own turns and to
 * their own name, and the extraction the loss could degrade is theirs alone. Privacy
 * wins: it is their name, and leaking it is the thing R32 exists to stop.
 */

/**
 * What a redacted name token becomes. Deliberately NOT `[PERSON_1]`: the
 * ai-service's own gateway mints that family, and keeping them distinct means a
 * trace can tell "the API knew this name and removed it" apart from "the gateway
 * guessed". Carries no digits, so it can never feed the residual-digit net.
 */
export const REDACTED_NAME_PLACEHOLDER = "[NAME]";

/**
 * Name tokens shorter than this are NOT redacted.
 *
 * Load-bearing: Indian stored names routinely carry initials ("R Suresh Kumar",
 * "K. M. Ramesh"). Redacting a 1-2 character token would rewrite every "R", "ka",
 * "me" and "hai" in the message and shred the text the extractor reads — the exact
 * over-masking regression class that killed the gazetteer attempt. 3 is the shortest
 * length at which a token is a name rather than a letter.
 */
const MIN_TOKEN_LENGTH = 3;

/** Escape a literal so it can be embedded in a RegExp source. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redact every occurrence of `fullName` — as a whole, and each of its tokens
 * independently — from `text`.
 *
 * - CASE-INSENSITIVE: workers type "suresh", the DB holds "Suresh".
 * - TOKEN-WISE: "Suresh Kumar" also removes a bare "Suresh" and a bare "Kumar",
 *   because a worker introduces themselves either way across turns.
 * - WORD-ANCHORED with Unicode lookarounds (not `\b`, which is ASCII-only and would
 *   mis-anchor on Devanagari): "Ram" never matches inside "Rampur" or "programme".
 * - WHITESPACE-TOLERANT on the full-name alternative: a stored "Suresh  Kumar" (or
 *   one carrying a newline/tab) still matches the single-spaced form the worker types.
 * - REPEATED occurrences all go (global match).
 *
 * FAIL SAFE, NOT CLOSED: a null/blank/unusable name returns `text` UNCHANGED. A
 * decrypt failure upstream must never break a chat turn — the ai-service's
 * pseudonymize gate is still in front of the LLM, so the un-redacted path is the
 * status quo, not a new exposure. Callers log the failure WITHOUT the value.
 */
export function redactKnownName(text: string, fullName: string | null | undefined): string {
  if (typeof text !== "string" || text.length === 0) return text;
  if (typeof fullName !== "string") return text;

  const tokens = fullName
    .trim()
    .split(/\s+/)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH);
  if (tokens.length === 0) return text;

  // The FULL name first so a multi-token name collapses to ONE placeholder
  // ("Suresh Kumar" -> "[NAME]", not "[NAME] [NAME]"). Alternation is first-match-
  // wins in JS, so ordering here is the whole mechanism; the remaining tokens are
  // sorted longest-first for the same reason (a surname that contains a shorter
  // token must not be eaten by it).
  const alternatives: string[] = [];
  if (tokens.length > 1) {
    alternatives.push(tokens.map(escapeRegExp).join("\\s+"));
  }
  const seen = new Set<string>();
  for (const token of [...tokens].sort((a, b) => b.length - a.length)) {
    const key = token.toLowerCase();
    if (seen.has(key)) continue; // repeated token in the stored name
    seen.add(key);
    alternatives.push(escapeRegExp(token));
  }

  // Unicode-aware word anchoring. `\b` is defined on ASCII `\w`, so `\bराम\b` and
  // `\bRam\b` behave inconsistently across the scripts this product actually sees.
  // The lookarounds say exactly what is meant: not adjacent to another letter,
  // digit, or underscore.
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}_])`,
    "giu",
  );
  // Function replacement (never a string) so a placeholder containing `$&`-style
  // patterns could never be reinterpreted — same discipline as `renderWorkerName`.
  return text.replace(pattern, () => REDACTED_NAME_PLACEHOLDER);
}
