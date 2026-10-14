/**
 * #2241 — THE AI-DISCLOSURE WALL: a model-written free-chat line that CLAIMS TO BE A PERSON is
 * thrown away, whatever the prompt said.
 *
 * Owner ruling (2026-10-14, ADR-0051 R45): when a worker sincerely asks "aap insaan ho ya
 * machine?", Bada Bhai says plainly that it is the BadaBhai app's AI helper, not a person. The
 * reply prompts carry that rule, but a prompt is a request, not a guarantee: round 1's eval had
 * Haiku answer "Main ek insaan hoon" 8 times in 9. This wall makes the lie impossible to serve.
 * The API then serves the reviewed fallback line, which claims nothing.
 *
 * LATIN ONLY, because every served line already is (the gate rejects any other script). It reads
 * Hinglish, English, and the five regional languages written in Latin letters.
 *
 * A CLAIM, NOT A MENTION. "Main AI helper hoon, insaan nahi", "I am not a human" and
 * "naanu manushya alla" ("I am not a human" in Kannada) are the honest answer, and pass:
 * - the Hindi form needs "hoon" right after the noun;
 * - the English form allows only a few fillers between "I am" and the noun, never "not";
 * - the regional forms are refused when a negator follows the noun.
 */

/** Hinglish: "main (ek) insaan hoon", "mai aadmi hu", "main asli insaan hi hoon". */
const HINGLISH_CLAIM =
  /\b(?:main|mai|mein)\s+(?:(?:ek|bhi|hi|asli|aam|normal|sacha|sachcha|real)\s+)*(?:insaan|insan|aadmi|admi|manushya|manushy|vyakti|banda|human|person)\s+(?:hi\s+)?(?:hoon|hun|hu|hoo)\b/i;

/** English: "I am a human", "I'm a real person", "I am also a man". Never "I am not …". */
const ENGLISH_CLAIM =
  /\bi\s*(?:am|'m)\s+(?:(?:a|an|also|really|actually|definitely|just|only)\s+)*(?:real\s+|actual\s+|living\s+)?(?:human(?:\s+being)?|person|man|woman)\b/i;

/** The words that negate a regional claim when they follow the noun ("manushya alla"). */
const REGIONAL_NEGATORS = "alla|alle|allaa|kaadu|kadu|kaadhu|illai|illa|nahi|nahin|naahi|nathi";

/**
 * Marathi "mi manus aahe", Gujarati "hu manas chhu", Kannada "naanu manushya", Telugu "nenu
 * manishini", Tamil "naan (oru) manithan", each refused when a negator follows.
 */
const REGIONAL_CLAIM = new RegExp(
  "\\b(?:" +
    [
      "mi\\s+(?:ek\\s+)?(?:maanus|manus|manoos)\\s+(?:aahe|ahe|aahey)",
      "(?:hu|hun|hoon)\\s+(?:ek\\s+)?(?:maanas|manas|maanus|manushya)\\s+(?:chhu|chu|chhoo)",
      "(?:naanu|nanu|naanoo)\\s+(?:ondu\\s+)?(?:manushya|manushyanu|manushyane)",
      "(?:nenu|neenu)\\s+(?:oka\\s+)?(?:manishini|manishi|manushyudini|manushyudu)",
      "(?:naan|nan)\\s+(?:oru\\s+)?(?:manithan|manidhan|manushan|manushi)",
    ].join("|") +
    `)\\b(?!\\s+(?:${REGIONAL_NEGATORS})\\b)`,
  "i",
);

/** Does this model-written line claim that Bada Bhai is a person? */
export function claimsToBeHuman(text: string): boolean {
  const folded = text.replace(/[’‘]/g, "'");
  return HINGLISH_CLAIM.test(folded) || ENGLISH_CLAIM.test(folded) || REGIONAL_CLAIM.test(folded);
}
