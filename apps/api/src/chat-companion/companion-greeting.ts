/**
 * IS THIS MESSAGE A BARE GREETING? (#2287, owner ruling 2026-10-15) — deterministic, closed, pure.
 *
 * WHY. On the free-chat brain a greeting went to the classifier (ADR-0055 R3), and the #2285 eval
 * showed the model failing exactly there: a bare "hello" classified `unclear` (the clarify line), a
 * "namaste" answered with two questions (rejected by the gate, the fallback line). A greeting carries
 * no question, so it gets a fixed reviewed line (`V3_GREETING`) and no model call.
 *
 * NARROW ON PURPOSE. A message is bare only when EVERY word is a greeting or a filler, with at least
 * one greeting:
 *   - greetings: the single words below ("namaste", "hello", "hi", "hey", "pranam", "salaam", …,
 *     with their common elongations "hiii", "heyyy", "hellooo", "namasteee") and the closed phrases
 *     "ram ram", "good morning / afternoon / evening" — in Latin letters or Devanagari;
 *   - fillers: how a worker addresses Bada Bhai ("bada", "bhai", "bhaiya", "ji", "sir", "madam");
 *   - punctuation and emoji are separators, so "🙏 namaste" and "hello!!" are bare.
 * Anything else — "hello, welder ki salary kitni hai", "namaste bada bhai kaise ho aap" — carries
 * content and still goes to the brain. A word missing from these lists costs one classifier call,
 * exactly as before; a wrong word in them would hide a question, so none of them is a content word
 * ("hai", "kaise", "aap" are deliberately absent).
 */

/** One-word greetings, as written (folded below). */
const GREETING_WORDS: readonly string[] = [
  "namaste",
  "namastey",
  "namaskar",
  "namaskaar",
  "pranam",
  "pranaam",
  "hello",
  "helo",
  "hallo",
  "hlo",
  "hi",
  "hii",
  "hey",
  "salaam",
  "salam",
  "नमस्ते",
  "नमस्कार",
  "प्रणाम",
  "हेलो",
  "हैलो",
  "हाय",
  "सलाम",
];

/** The common elongations of the Latin greetings: "hiii", "heyyy", "hellooo", "namasteee". */
const ELONGATED_GREETINGS: readonly RegExp[] = [/^h+i+$/, /^he+y+$/, /^hel+o+$/, /^namaste+y?$/];

/** Multi-word greetings: every word in order. */
const GREETING_PHRASES: readonly (readonly string[])[] = [
  ["ram", "ram"],
  ["राम", "राम"],
  ["good", "morning"],
  ["good", "afternoon"],
  ["good", "evening"],
];

/** Words that only address Bada Bhai — never content. */
const FILLER_WORDS: readonly string[] = [
  "bada",
  "bade",
  "badabhai",
  "bhai",
  "bhaiya",
  "bhaiyya",
  "ji",
  "jee",
  "sir",
  "madam",
  "maam",
  "बड़ा",
  "बड़े",
  "भाई",
  "भैया",
  "जी",
  "सर",
];

/** A word as compared: NFC (one spelling of a nukta letter), lowercased. */
function fold(word: string): string {
  return word.normalize("NFC").toLowerCase();
}

const GREETINGS: ReadonlySet<string> = new Set(GREETING_WORDS.map(fold));
const FILLERS: ReadonlySet<string> = new Set(FILLER_WORDS.map(fold));
const PHRASES: readonly (readonly string[])[] = GREETING_PHRASES.map((phrase) => phrase.map(fold));

/**
 * The message's words: everything that is not a letter, a combining mark or a digit is a separator
 * (punctuation, emoji, spaces), and Unicode format characters are dropped first so an invisible
 * character cannot split or glue a word.
 */
function wordsOf(text: string): string[] {
  const folded = fold(text.replace(/\p{Cf}/gu, ""))
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
  return folded.length === 0 ? [] : folded.split(" ");
}

function isGreetingWord(word: string): boolean {
  return GREETINGS.has(word) || ELONGATED_GREETINGS.some((pattern) => pattern.test(word));
}

/** How many words a greeting starting at `at` spans (a phrase, or one word), or 0 for none. */
function greetingAt(words: readonly string[], at: number): number {
  for (const phrase of PHRASES) {
    if (phrase.every((word, k) => words[at + k] === word)) return phrase.length;
  }
  return isGreetingWord(words[at]!) ? 1 : 0;
}

/** True when every word is a greeting or a filler, and at least one is a greeting. */
export function isBareGreeting(text: string): boolean {
  const words = wordsOf(text).filter((word) => !FILLERS.has(word));
  if (words.length === 0) return false;
  let at = 0;
  while (at < words.length) {
    const span = greetingAt(words, at);
    if (span === 0) return false;
    at += span;
  }
  return true;
}
