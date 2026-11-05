/**
 * #2384 — HOW A WORKER ANSWERS "Is kaam mein aapko kitne saal ho gaye?" WITHOUT SAYING "SAAL".
 *
 * The shared experience parser (`parseExperienceYears`, `@badabhai/profiling-lexicon`) reads a
 * NUMBER WITH ITS UNIT — "5 saal", "0 saal", "das years" — anywhere in a sentence, which is right
 * for a value mentioned in passing. It is wrong for the one question that already names the unit:
 * that question serves a GENERAL keyboard, so the answers it actually receives include "0", "5"
 * and "12" with no unit at all. Measured on device 2026-10-20: "0" was re-asked three
 * times, "5" loops the same way, and "10" was silently recorded unanswered.
 *
 * ON-SCREEN ONLY, and that is the safety of it. A bare number means years only next to the question
 * that asked in years; read in passing it could be a salary, a km figure or a shift length. So
 * {@link readStatedTenureYears} is called for the asked `experience_years` item and never by the
 * cross-question fill. It is also API-only: the lexicon's matcher is shared with the ai-service
 * (`signals.py`) and stays byte-identical.
 *
 * THE FRESHER WORDS ARE A CLOSED, REVIEWED LIST (owner ruling 2026-10-20): "0" in any form, "zero",
 * "fresher", "koi experience nahi", "experience nahi hai" mean 0 years — a fresher, accepted and
 * never re-asked. A sentence that also names a number with its unit is read by the shared parser
 * first ("welding ka experience nahi, fitting ka 3 saal" is 3), so these only ever decide a message
 * that carries no figure at all.
 */

/** ASCII and Devanagari digits, the same pair the shared experience matcher reads. */
const DIGIT = "[0-9०-९]";

/** A whole message that is only a number: "0", "5", "12", "2.5", "३". */
const BARE_NUMBER_RE = new RegExp(
  `^\\s*(${DIGIT}{1,2}(?:[.,]${DIGIT}+)?)\\s*[.!\\u0964]*\\s*$`,
  "u",
);

/** A whole message that is only ONE digit — the length the shared classifier calls `empty`. */
const LONE_DIGIT_RE = new RegExp(`^\\s*${DIGIT}\\s*$`, "u");

/**
 * Phrases that mean "I have no experience", matched word-bounded against the lowercased message.
 * Closed; extend by review. Every entry is about EXPERIENCE itself — a bare "nahi" or "koi nahi"
 * answers nothing about years and is left to the engine's ordinary no-value path.
 */
const FRESHER_PATTERNS: readonly RegExp[] = [
  /(?<![\p{L}\p{N}])fresher(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}])फ्रेशर(?![\p{L}\p{N}\p{M}])/u,
  /^\s*(?:zero|shunya|sifar)(?:\s+(?:saal|sal|years?|yrs?))?(?:\s+(?:hai|hain|h))?\s*[.!]*\s*$/u,
  /(?<![\p{L}\p{N}])(?:no|zero)\s+(?:experience|exp|work\s+experience)(?![\p{L}\p{N}])/u,
  /(?<![\p{L}\p{N}])(?:experience|exp|tajurba|tajurbaa|tajruba|anubhav)\s+(?:nahi|nahin|nhi|nai|nahi\s+hai|nahin\s+hai)(?![\p{L}\p{N}])/u,
  /(?:अनुभव|एक्सपीरियंस|तजुर्बा)\s+नहीं/u,
];

/** Devanagari digits to ASCII, so `Number()` can read them. */
function asciiDigits(text: string): string {
  return text.replace(/[०-९]/gu, (d) => String(d.charCodeAt(0) - 0x0966));
}

/** Is this whole message a single digit? Used to keep "0" from being read as silence. */
export function isLoneDigit(text: string): boolean {
  return LONE_DIGIT_RE.test(text);
}

/**
 * Years from an answer to the total-experience question that the shared parser could not read:
 * a bare number, or a fresher phrase (0). `null` when it is neither.
 */
export function readStatedTenureYears(text: string): number | null {
  const bare = BARE_NUMBER_RE.exec(text);
  if (bare) {
    const value = Number(asciiDigits(bare[1] as string).replace(",", "."));
    return Number.isFinite(value) ? value : null;
  }
  const lower = text.toLowerCase();
  return FRESHER_PATTERNS.some((pattern) => pattern.test(lower)) ? 0 : null;
}

/** The span of a bare-number answer, so the caller can set the figure aside as read. */
export function bareNumberSpan(text: string): { start: number; end: number } | undefined {
  const bare = BARE_NUMBER_RE.exec(text);
  if (!bare) return undefined;
  const start = text.indexOf(bare[1] as string);
  return { start, end: start + (bare[1] as string).length };
}
