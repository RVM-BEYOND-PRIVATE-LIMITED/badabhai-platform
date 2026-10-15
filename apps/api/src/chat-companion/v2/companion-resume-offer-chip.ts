/**
 * IS THIS FOLLOW-UP CHIP AN OFFER TO MAKE A RÉSUMÉ? (#2287, owner ruling 2026-10-15) — pure, closed.
 *
 * WHY. On the Bada Bhai chat the worker already HAS a résumé, yet the #2287 prompt round measured
 * the free-chat reply model adding chips like "Resume banane mein madad" (4 of 10 on `reply-129`). A
 * prompt fix for it cost career answers, so it was not shipped: the companion brain drops such chips
 * in code instead. The profiling free chat is untouched — it appends its own "Resume banayein" chip
 * on purpose, and nothing here runs there.
 *
 * THE RULE: a chip offers to make a résumé when it carries BOTH a résumé word (resume, résumé, cv,
 * biodata) AND a make word (bana / banana / banane / banao / banaye / banayein / banaiye, the
 * "banwa…" family, create, make, build, naya / nayi / new). Either alone is something else: "Resume
 * mein skill jodo" and "Resume download" are about the résumé the worker has; "Naya kaam dhoondho"
 * is about work. Words are compared case- and diacritic-insensitively ("Résumé" is "resume").
 *
 * Chips are Latin script (the reply gate refuses any other), so the lists are Latin. A make word
 * missing from them leaves one offer chip on screen, as before; a word wrongly in them would drop
 * a real chip, so none of them names anything but making.
 */

/** Words that name the résumé itself. */
const RESUME_WORDS: ReadonlySet<string> = new Set(["resume", "resumes", "cv", "cvs", "biodata"]);

/** Words that offer to make one. */
const MAKE_WORDS: ReadonlySet<string> = new Set([
  "bana",
  "banana",
  "banane",
  "banao",
  "banaye",
  "banayein",
  "banayen",
  "banaen",
  "banaiye",
  "banaate",
  "banate",
  "create",
  "creating",
  "make",
  "making",
  "build",
  "building",
  "naya",
  "nayi",
  "new",
]);

/** The "banwa…" family: banwa, banwana, banwane, banwao, banwaye, banwayein, banwaiye. */
const BANWA_FAMILY = /^banwa/;

/** A chip's words: accents off ("résumé" → "resume"), lowercased, every non-letter a separator. */
function wordsOf(chip: string): string[] {
  const folded = chip
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return folded.length === 0 ? [] : folded.split(" ");
}

function isMakeWord(word: string): boolean {
  return MAKE_WORDS.has(word) || BANWA_FAMILY.test(word);
}

/** True when the chip names the résumé AND offers to make one. */
export function isResumeOfferChip(chip: string): boolean {
  const words = wordsOf(chip);
  return words.some((word) => RESUME_WORDS.has(word)) && words.some(isMakeWord);
}
