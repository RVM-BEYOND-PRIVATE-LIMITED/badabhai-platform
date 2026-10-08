/**
 * THE FREE CHAT'S REPLY LANGUAGE (ADR-0051 §11, owner rulings R39–R41) — PURE: text in, a closed
 * `FreeChatReplyLanguage` out. No I/O, no model.
 *
 * CODE DECIDES, THE MODEL FOLLOWS (R39). On the production model the reply prompt's own "answer in
 * the worker's language" rule did not hold (9 of 10 regional questions came back in Hinglish), so
 * the language is decided here, deterministically, and handed to the reply and news calls as
 * `reply_language`.
 *
 * TWO READERS:
 *   - {@link detectReplyLanguage} — the language a message is WRITTEN in (R40). A Gujarati, Tamil,
 *     Telugu or Kannada script decides that language; Devanagari is Marathi when Marathi markers
 *     outweigh Hindi ones, else Hinglish; Latin text is scored against per-language marker words.
 *     A tie, or too little evidence, is Hinglish.
 *   - {@link parseLanguageRequest} — an EXPLICIT request to reply in a language (R41): "marathi mai
 *     jawab do", "reply in Tamil", "telugu lo cheppandi". A message that merely MENTIONS a language
 *     ("main marathi hoon", "tamil nadu mein kaam") is not one.
 *
 * THE WORD LISTS ARE CLOSED AND FABRICATED — common romanized spellings, not a corpus of anyone's
 * words. A word two languages share (Hindi and Marathi "nahi", Tamil and Kannada "illa", Hindi
 * "thi" and Gujarati "thi") belongs to NEITHER list: a shared word is no evidence. A miss costs a
 * Hinglish reply, which is what the chat served before this ruling.
 *
 * NO RUNTIME IMPORTS: the closed set is imported as a type and every list below is checked against
 * it by `satisfies`, so this module stays readable by anything that boots nothing.
 */

import type { FreeChatReplyLanguage } from "@badabhai/types";

/** The regional languages a script or a marker list can decide — every member but the two defaults. */
type RegionalLanguage = Exclude<FreeChatReplyLanguage, "english" | "hinglish">;

// ---------------------------------------------------------------------------
// Tokenizing — letters and their marks kept, so an Indic word survives whole
// ---------------------------------------------------------------------------

/**
 * One token, normalized: NFC (so a precomposed nukta letter and its decomposed spelling are one
 * word), lowercased, the zero-width joiner and non-joiner dropped (Indic keyboards insert them
 * inside a word, and they are not separators).
 */
function normalizeToken(token: string): string {
  return token.normalize("NFC").toLowerCase().replace(/[‌‍]/g, "");
}

/**
 * A message as tokens: apostrophes dropped ("don't" is "dont"), every run of anything that is not
 * a letter, a combining mark or a digit a separator. UNLIKE the chip fold in `free-chat.router.ts`,
 * the combining marks are KEPT: a Devanagari or Dravidian vowel sign is part of the word, and
 * stripping it would make "मराठी" read as "मरठ".
 */
export function languageTokens(text: string): string[] {
  const folded = normalizeToken(text)
    .replace(/['`‘’ʼ]/g, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
  return folded.length === 0 ? [] : folded.split(" ");
}

/** A closed word list as a set of normalized tokens. */
function wordSet(words: readonly string[]): ReadonlySet<string> {
  return new Set(words.map(normalizeToken));
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

/**
 * The Indic scripts the detector reads: Devanagari (Hindi or Marathi), and the four scripts that
 * each belong to one language — so a regional script's name IS its language.
 */
type Script = "devanagari" | Exclude<RegionalLanguage, "marathi">;

/** The Unicode blocks the detector reads, inclusive. */
const SCRIPT_BLOCKS: ReadonlyArray<readonly [lo: number, hi: number, script: Script]> = [
  [0x0900, 0x097f, "devanagari"],
  [0x0a80, 0x0aff, "gujarati"],
  [0x0b80, 0x0bff, "tamil"],
  [0x0c00, 0x0c7f, "telugu"],
  [0x0c80, 0x0cff, "kannada"],
];

/** How many characters of each Indic script the text carries. */
function scriptCounts(text: string): Map<Script, number> {
  const counts = new Map<Script, number>();
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const block = SCRIPT_BLOCKS.find(([lo, hi]) => code >= lo && code <= hi);
    if (block !== undefined) counts.set(block[2], (counts.get(block[2]) ?? 0) + 1);
  }
  return counts;
}

/**
 * The script that decides, or null for a Latin-only (or script-less) message. A Gujarati, Tamil,
 * Telugu or Kannada script decides its language as long as it carries at least as many characters
 * as Devanagari. Two regional scripts tied at the top decide nothing (Hinglish).
 */
function decidingScript(text: string): Script | "tie" | null {
  const counts = scriptCounts(text);
  if (counts.size === 0) return null;
  let top: Script | null = null;
  let best = 0;
  let tied = false;
  for (const [script, n] of counts) {
    if (script === "devanagari") continue;
    if (n > best) {
      top = script;
      best = n;
      tied = false;
    } else if (n === best) {
      tied = true;
    }
  }
  if (top !== null && best >= (counts.get("devanagari") ?? 0)) return tied ? "tie" : top;
  return "devanagari";
}

// ---------------------------------------------------------------------------
// Devanagari: Marathi or Hindi
// ---------------------------------------------------------------------------

/**
 * Marathi in Devanagari. NOT here, because Hindi writes them too: नाही/नहीं's shared sense, का
 * (Marathi "why", Hindi possessive), की, तो, हो, काम, आज, जाते.
 */
const MARATHI_DEVANAGARI = wordSet([
  "आहे",
  "आहेत",
  "आहात",
  "आहेस",
  "आहोत",
  "नाहीये",
  "मला",
  "मी",
  "माझा",
  "माझी",
  "माझे",
  "माझं",
  "तुम्ही",
  "तुम्हाला",
  "तुमचा",
  "तुमची",
  "तुमचे",
  "तुमचं",
  "तुला",
  "तुझा",
  "काय",
  "कसा",
  "कसे",
  "कशी",
  "कसं",
  "कुठे",
  "कुठं",
  "कधी",
  "आणि",
  "पण",
  "करायचं",
  "करायचे",
  "करायची",
  "करायचा",
  "पाहिजे",
  "पाहिजेत",
  "मध्ये",
  "म्हणजे",
  "सांगा",
  "सांगू",
  "नको",
  "होय",
  "आम्ही",
  "आपण",
  "त्याला",
  "तिला",
  "त्यांना",
  "झाला",
  "झाली",
  "झाले",
  "झालं",
  "केला",
  "केली",
  "केले",
  "केलं",
  "मिळेल",
  "मिळाला",
  "मिळाली",
  "शकतो",
  "शकते",
  "शकता",
  "असते",
  "असतो",
  "खूप",
  "चांगला",
  "चांगली",
  "चांगले",
  "चांगलं",
  "छान",
  "वाटतं",
  "वाटते",
  "वाटत",
  "येतो",
  "येते",
  "जातो",
  "राहतो",
  "राहते",
  "माहिती",
  "किती",
  "नोकरी",
  "जास्त",
  "द्या",
  "घ्या",
  "बघा",
]);

/** Hindi in Devanagari — see {@link MARATHI_DEVANAGARI} for the shared words left out of both. */
const HINDI_DEVANAGARI = wordSet([
  "है",
  "हैं",
  "हूँ",
  "हूं",
  "था",
  "थी",
  "थे",
  "क्या",
  "मुझे",
  "मुझको",
  "मेरा",
  "मेरी",
  "मेरे",
  "मैं",
  "आप",
  "आपका",
  "आपकी",
  "आपके",
  "आपको",
  "कैसे",
  "कैसा",
  "कैसी",
  "कहाँ",
  "कहां",
  "कब",
  "चाहिए",
  "चाहिये",
  "और",
  "नहीं",
  "नही",
  "में",
  "के",
  "को",
  "से",
  "पर",
  "लेकिन",
  "बहुत",
  "अच्छा",
  "अच्छी",
  "अच्छे",
  "करना",
  "करता",
  "करती",
  "करते",
  "सकता",
  "सकती",
  "सकते",
  "गया",
  "गई",
  "गयी",
  "गए",
  "रहा",
  "रही",
  "रहे",
  "हम",
  "तुम",
  "तुम्हारा",
  "यह",
  "वह",
  "ये",
  "वो",
  "भी",
  "कोई",
  "कुछ",
  "कितना",
  "कितनी",
  "कितने",
  "कौन",
  "अभी",
  "बताओ",
  "बताइए",
  "बताइये",
  "समझ",
  "हाँ",
  "हां",
  "वाला",
  "वाली",
  "वाले",
  "लिए",
  "दिया",
  "मिलेगा",
  "मिलेगी",
  "मिलता",
  "मिलती",
  "होगा",
  "होगी",
  "जाना",
  "आता",
  "आती",
  "नौकरी",
  "पता",
]);

// ---------------------------------------------------------------------------
// Latin: per-language marker words
// ---------------------------------------------------------------------------

/**
 * Hindi / Hinglish in Latin letters. LEFT OUT on purpose — English words ("me", "to", "the",
 * "main", "is", "us", "do", "hi"), words a regional language writes the same way ("ka" and "ki"
 * are Marathi particles too, "kon" is Marathi "who", "aata" Marathi "now", "thi" and "hu" are
 * Gujarati, "aap" is Gujarati's respectful "you", "karo", "rahe" and "kai" are Gujarati, "kar",
 * "kaam", "paise", "aaj", "kal", "thik", "theek", "ji", "bilkul" and "jaroor" are shared with
 * Marathi), and the shared negation "nahi".
 */
const HINDI_LATIN = wordSet([
  "hai",
  "hain",
  "hoon",
  "hun",
  "tha",
  "hua",
  "hui",
  "hue",
  "kya",
  "kyu",
  "kyun",
  "kyon",
  "mujhe",
  "muje",
  "mujhko",
  "mujhse",
  "maine",
  "usne",
  "unhone",
  "humne",
  "aapne",
  "apne",
  "mera",
  "meri",
  "mere",
  "mai",
  "mein",
  "paas",
  "saal",
  "mahine",
  "mahina",
  "mila",
  "mili",
  "karunga",
  "karungi",
  "dunga",
  "hum",
  "humein",
  "humko",
  "hame",
  "hamein",
  "hamara",
  "hamari",
  "aapka",
  "aapki",
  "aapke",
  "aapko",
  "apka",
  "apki",
  "apke",
  "apko",
  "tum",
  "tumhe",
  "tumhara",
  "kaise",
  "kaisa",
  "kaisi",
  "kese",
  "kaha",
  "kahan",
  "kab",
  "chahiye",
  "chahie",
  "chaiye",
  "chahta",
  "chahti",
  "chahte",
  "nahin",
  "nhi",
  "nai",
  "aur",
  "ke",
  "ko",
  "se",
  "par",
  "pe",
  "lekin",
  "bahut",
  "bohot",
  "bahot",
  "bhot",
  "accha",
  "acha",
  "achha",
  "achi",
  "achhi",
  "acchi",
  "karna",
  "karta",
  "karti",
  "karte",
  "kiya",
  "kiye",
  "kijiye",
  "kariye",
  "sakta",
  "sakti",
  "sakte",
  "gaya",
  "gayi",
  "gaye",
  "raha",
  "rahi",
  "yeh",
  "ye",
  "woh",
  "wo",
  "bhi",
  "toh",
  "koi",
  "kuch",
  "kitna",
  "kitni",
  "kitne",
  "kaun",
  "kaunsa",
  "abhi",
  "ab",
  "batao",
  "bataiye",
  "batayein",
  "bataye",
  "samajh",
  "samjha",
  "samjhao",
  "haan",
  "wala",
  "wali",
  "wale",
  "liye",
  "lie",
  "diya",
  "dena",
  "lena",
  "milega",
  "milegi",
  "milta",
  "milti",
  "chalega",
  "hoga",
  "hogi",
  "honge",
  "padega",
  "jaana",
  "jana",
  "jata",
  "jati",
  "aati",
  "aate",
  "yaha",
  "yahan",
  "waha",
  "wahan",
  "kyunki",
  "agar",
  "magar",
  "jaise",
  "sirf",
  "matlab",
  "pata",
  "maloom",
  "malum",
  "kidhar",
  "idhar",
  "udhar",
  "dekho",
  "dekhiye",
  "suno",
  "suniye",
  "bolna",
  "boliye",
  "seekhna",
  "sikhna",
]);

/**
 * Each regional language's marker words in Latin letters. LEFT OUT on purpose, as shared: "nahi"
 * (Hindi and Marathi), "illa" / "illai" (Tamil and Kannada), "namma" (Tamil and Kannada), "sari"
 * (Tamil and Kannada), "nanna" (Kannada "my", Telugu "father"), "bola" (Marathi imperative, Hindi
 * past tense), "chala" and "pani" (Telugu, and Hindi "went" / "water"), "aana" (Tamil "but", Hindi
 * "to come"), "kara" and "kami" (Marathi, and Hindi), "thi" / "hu" / "ma" / "kya" / "kai"
 * (Gujarati, and Hindi), "tya" (Gujarati and Marathi), "nokri" (Marathi and Gujarati). And no
 * English word: "ide" stays (Kannada "is"), its English sense being rare in this chat.
 */
const REGIONAL_LATIN = {
  marathi: wordSet([
    "aahe",
    "ahe",
    "aahet",
    "ahet",
    "aahat",
    "ahat",
    "aahes",
    "ahes",
    "aahot",
    "nahiye",
    "mala",
    "mla",
    "majha",
    "maza",
    "mazha",
    "majhi",
    "mazi",
    "majhe",
    "maze",
    "tumhi",
    "tumhala",
    "tumcha",
    "tumchi",
    "tumche",
    "tula",
    "tuza",
    "tuzha",
    "kay",
    "kasa",
    "kase",
    "kashi",
    "kuthe",
    "kuthay",
    "kadhi",
    "ani",
    "aani",
    "karaycha",
    "karaychi",
    "karayche",
    "karaychay",
    "pahije",
    "pahijet",
    "madhe",
    "madhye",
    "mhanje",
    "sanga",
    "sangal",
    "sangu",
    "nako",
    "hoy",
    "aamhi",
    "amhi",
    "aapan",
    "apan",
    "tyala",
    "tila",
    "tyanna",
    "zala",
    "jhala",
    "zali",
    "jhali",
    "zale",
    "jhale",
    "kela",
    "keli",
    "kele",
    "milel",
    "milala",
    "shakto",
    "shakte",
    "aste",
    "asto",
    "khup",
    "changla",
    "changli",
    "changle",
    "chan",
    "vatta",
    "vatte",
    "vatat",
    "yeto",
    "yete",
    "jato",
    "rahto",
    "rahte",
    "mahiti",
    "kiti",
    "kuthla",
    "kuthli",
    "kontya",
    "konta",
    "bagha",
    "ghya",
    "dya",
    "jast",
    "jasta",
  ]),
  gujarati: wordSet([
    "chhe",
    "che",
    "chho",
    "cho",
    "chhu",
    "chu",
    "chhiye",
    "chiye",
    "hatu",
    "hati",
    "maru",
    "mare",
    "mane",
    "tame",
    "tamne",
    "tamaru",
    "tamari",
    "tamara",
    "kem",
    "shu",
    "karvu",
    "karvanu",
    "karyu",
    "joie",
    "joiye",
    "joyie",
    "joitu",
    "joiee",
    "nathi",
    "kyare",
    "kevi",
    "kevu",
    "saru",
    "saras",
    "majama",
    "majaama",
    "malse",
    "madse",
    "malshe",
    "aapo",
    "apo",
    "shakay",
    "shaku",
    "rehvu",
    "aavjo",
    "evu",
    "pachhi",
    "pachi",
    "ahiya",
    "kone",
    "puchhvu",
  ]),
  tamil: wordSet([
    "enakku",
    "enaku",
    "unakku",
    "ungalukku",
    "ungaluku",
    "eppadi",
    "epdi",
    "enna",
    "ennachu",
    "vela",
    "velai",
    "venum",
    "vendum",
    "sollunga",
    "sollu",
    "solla",
    "irukku",
    "iruku",
    "irukken",
    "irukeenga",
    "irukinga",
    "irukkinga",
    "naan",
    "neenga",
    "ninga",
    "unga",
    "enga",
    "ennoda",
    "enoda",
    "unnoda",
    "panna",
    "pannanum",
    "pannunga",
    "pannuren",
    "panren",
    "theriyum",
    "theriyuma",
    "theriyala",
    "therila",
    "romba",
    "nalla",
    "kidaikkum",
    "kidaikuma",
    "kidaikkuma",
    "kedaikum",
    "sambalam",
    "evlo",
    "evvalavu",
    "eppo",
    "yaaru",
    "vanakkam",
    "nandri",
    "aamaa",
    "seri",
    "padikka",
    "padichen",
    "vaanga",
    "ponga",
    "poren",
    "varen",
  ]),
  telugu: wordSet([
    "naaku",
    "naku",
    "meeku",
    "miku",
    "nenu",
    "meeru",
    "miru",
    "ela",
    "elaa",
    "emiti",
    "enti",
    "kavali",
    "kaavali",
    "cheyyali",
    "cheyali",
    "cheyandi",
    "cheppandi",
    "cheppu",
    "undi",
    "unnayi",
    "unnadi",
    "ledu",
    "vaddu",
    "kaadu",
    "avunu",
    "ippudu",
    "eppudu",
    "ekkada",
    "enduku",
    "baagundi",
    "bagundi",
    "manchi",
    "bagunnara",
    "bagunnava",
    "bagunnaru",
    "udyogam",
    "jeetham",
    "vachindi",
    "vastundi",
    "telusu",
    "teliyadu",
    "chestanu",
    "chesanu",
    "chestunna",
    "chesthunna",
    "ivvandi",
    "garu",
    "andi",
    "matladandi",
  ]),
  kannada: wordSet([
    "nanage",
    "nange",
    "nimage",
    "ninage",
    "hege",
    "yenu",
    "beku",
    "bekagide",
    "beda",
    "maadi",
    "madi",
    "maadbeku",
    "maadtini",
    "madtini",
    "ide",
    "ideya",
    "neevu",
    "nivu",
    "neenu",
    "naanu",
    "nimma",
    "yaake",
    "yake",
    "elli",
    "yavaga",
    "yaavaga",
    "gottu",
    "gothilla",
    "gottilla",
    "swalpa",
    "tumba",
    "chennagide",
    "chennagi",
    "kelsa",
    "kelasa",
    "sambala",
    "sigutte",
    "sigatte",
    "heli",
    "helri",
    "hogi",
    "banni",
    "iddini",
    "iddira",
    "idira",
    "hegiddira",
    "hegiddiya",
    "chennagiddira",
    "eshtu",
    "aagutte",
    "agutte",
  ]),
} as const satisfies Record<RegionalLanguage, ReadonlySet<string>>;

const REGIONAL_LANGUAGES = Object.keys(REGIONAL_LATIN) as RegionalLanguage[];

/**
 * English function words — the evidence a Latin message is English. Deliberately NOT here: the
 * greetings and acknowledgements every chat uses in any language ("hi", "hello", "ok", "yes",
 * "no", "please", "thanks"), and the loanwords Hinglish writes in English ("job", "work",
 * "salary"). Those prove nothing about the worker's language.
 */
const ENGLISH_LATIN = wordSet([
  "i",
  "im",
  "me",
  "my",
  "mine",
  "you",
  "your",
  "youre",
  "we",
  "our",
  "they",
  "their",
  "he",
  "she",
  "it",
  "its",
  "is",
  "are",
  "am",
  "was",
  "were",
  "be",
  "been",
  "the",
  "a",
  "an",
  "to",
  "for",
  "of",
  "in",
  "on",
  "at",
  "with",
  "from",
  "by",
  "about",
  "as",
  "into",
  "what",
  "how",
  "where",
  "when",
  "why",
  "which",
  "who",
  "can",
  "could",
  "should",
  "would",
  "will",
  "do",
  "does",
  "did",
  "dont",
  "doesnt",
  "didnt",
  "have",
  "has",
  "had",
  "need",
  "want",
  "get",
  "this",
  "that",
  "these",
  "those",
  "there",
  "here",
  "and",
  "or",
  "but",
  "not",
  "so",
  "if",
  "then",
  "than",
  "also",
  "very",
  "any",
  "some",
  "more",
  "much",
  "many",
  "tell",
  "know",
  "like",
]);

/** Fewer Latin words than this is too little evidence: "ok", "hello", an emoji — Hinglish. */
const MIN_EVIDENCE_WORDS = 2;
/** English needs at least this many function words… */
const MIN_ENGLISH_WORDS = 2;
/** …and they must be at least this share of the message's words ("mostly English"). */
const MIN_ENGLISH_SHARE = 1 / 3;

/** How many of `words` are in `set`. */
function score(words: readonly string[], set: ReadonlySet<string>): number {
  return words.reduce((n, word) => n + (set.has(word) ? 1 : 0), 0);
}

/** Devanagari: Marathi when its markers outweigh Hindi's; a tie or nothing is Hinglish. */
function devanagariLanguage(tokens: readonly string[]): FreeChatReplyLanguage {
  return score(tokens, MARATHI_DEVANAGARI) > score(tokens, HINDI_DEVANAGARI)
    ? "marathi"
    : "hinglish";
}

/**
 * Latin letters, in this order:
 *   1. too few words → Hinglish;
 *   2. the regional language with the most markers wins if it is the ONLY one at the top, beats
 *      Hindi's count, and is either two markers strong or at least as strong as the English
 *      evidence (one false friend in an English sentence decides nothing);
 *   3. any Hindi marker → Hinglish;
 *   4. mostly English function words → English;
 *   5. anything else → Hinglish (unsure).
 */
function latinLanguage(tokens: readonly string[]): FreeChatReplyLanguage {
  const words = tokens.filter((token) => /^[a-z]+$/.test(token));
  if (words.length < MIN_EVIDENCE_WORDS) return "hinglish";
  const hindi = score(words, HINDI_LATIN);
  const english = score(words, ENGLISH_LATIN);

  let top: RegionalLanguage | null = null;
  let best = 0;
  let tied = false;
  for (const language of REGIONAL_LANGUAGES) {
    const n = score(words, REGIONAL_LATIN[language]);
    if (n > best) {
      top = language;
      best = n;
      tied = false;
    } else if (n === best && n > 0) {
      tied = true;
    }
  }
  if (top !== null && !tied && best > hindi && (best >= 2 || best >= english)) return top;
  if (hindi > 0) return "hinglish";
  if (english >= MIN_ENGLISH_WORDS && english >= words.length * MIN_ENGLISH_SHARE) return "english";
  return "hinglish";
}

/**
 * THE LANGUAGE ONE MESSAGE IS WRITTEN IN (R40) — the reply's language when the worker keeps none.
 * Never throws; anything it cannot read is Hinglish, the chat's language before this ruling.
 */
export function detectReplyLanguage(text: string): FreeChatReplyLanguage {
  const script = decidingScript(text);
  if (script === "tie") return "hinglish";
  if (script === "devanagari") return devanagariLanguage(languageTokens(text));
  if (script !== null) return script;
  return latinLanguage(languageTokens(text));
}

// ---------------------------------------------------------------------------
// An explicit request: "marathi mai jawab do", "reply in Tamil" (R41)
// ---------------------------------------------------------------------------

/**
 * Each language's NAME, as a word on its own: Latin spellings and the native and Devanagari
 * scripts. `hinglish` is asked for as "Hindi".
 */
const LANGUAGE_NAMES = {
  english: [
    "english",
    "inglish",
    "angrezi",
    "angreji",
    "angrezee",
    "angraji",
    "अंग्रेज़ी",
    "अंग्रेजी",
    "इंग्लिश",
  ],
  hinglish: ["hindi", "hindee", "hinglish", "हिंदी", "हिन्दी"],
  marathi: ["marathi", "marathee", "मराठी"],
  gujarati: ["gujarati", "gujrati", "gujarathi", "ગુજરાતી", "गुजराती"],
  kannada: ["kannada", "kannad", "kanada", "ಕನ್ನಡ", "कन्नड़", "कन्नड"],
  telugu: ["telugu", "telgu", "thelugu", "తెలుగు", "तेलुगु"],
  tamil: ["tamil", "thamil", "tamizh", "thamizh", "தமிழ்", "तमिल"],
} as const satisfies Record<FreeChatReplyLanguage, readonly string[]>;

/**
 * A language's name with "in" GLUED ON — one word that already means "in Marathi": "marathit",
 * "telugulo", "kannadadalli", "tamizhil", "ગુજરાતીમાં". Listed whole, never matched as a prefix:
 * "தமிழ்நாடு" (Tamil Nadu) starts with "தமிழ்" and is not a request.
 */
const GLUED_LOCATIVES = {
  english: ["englishmein", "englishme", "englishmai", "angrezimein", "angrezime"],
  hinglish: ["hindimein", "hindime", "hindimai", "हिंदीमें"],
  marathi: [
    "marathit",
    "marathitun",
    "marathimadhe",
    "marathimadhye",
    "marathimein",
    "marathime",
    "मराठीत",
    "मराठीतून",
    "मराठीमध्ये",
  ],
  gujarati: ["gujaratima", "gujratima", "gujaratimaa", "ગુજરાતીમાં", "ગુજરાતીમા"],
  kannada: ["kannadadalli", "kannadalli", "kannadaalli", "kannadadali", "ಕನ್ನಡದಲ್ಲಿ", "ಕನ್ನಡದಲ್ಲೇ"],
  telugu: ["telugulo", "telgulo", "తెలుగులో"],
  tamil: ["tamilla", "tamille", "tamilil", "tamizhil", "thamizhil", "தமிழில்", "தமிழ்ல"],
} as const satisfies Record<FreeChatReplyLanguage, readonly string[]>;

/** What one name token says: the language, and whether "in" is glued onto it. */
interface NamedLanguage {
  readonly language: FreeChatReplyLanguage;
  readonly glued: boolean;
}

/** One list's tokens, each pointing at its language. */
function nameEntries(
  lists: Readonly<Record<FreeChatReplyLanguage, readonly string[]>>,
  glued: boolean,
): Array<[string, NamedLanguage]> {
  return (Object.entries(lists) as Array<[FreeChatReplyLanguage, readonly string[]]>).flatMap(
    ([language, names]) =>
      names.map((name): [string, NamedLanguage] => [normalizeToken(name), { language, glued }]),
  );
}

/** Token → the language it names (bare or with "in" glued on). */
const NAME_INDEX: ReadonlyMap<string, NamedLanguage> = new Map([
  ...nameEntries(LANGUAGE_NAMES, false),
  ...nameEntries(GLUED_LOCATIVES, true),
]);

/** The language a token names (bare or with "in" glued on), or null. */
export function languageNamed(token: string): FreeChatReplyLanguage | null {
  return NAME_INDEX.get(normalizeToken(token))?.language ?? null;
}

/** "in", written AFTER the name: Hindi mein / Marathi madhe / Gujarati ma / Tamil-la / Telugu lo… */
const LOCATIVES = wordSet([
  "mein",
  "me",
  "mai",
  "main",
  "mei",
  "mae",
  "mien",
  "mee",
  "ma",
  "maa",
  "madhe",
  "madhye",
  "la",
  "le",
  "lo",
  "alli",
  "dalli",
  "il",
  "में",
  "मे",
  "मैं",
  "मध्ये",
  "માં",
  "లో",
  "ಅಲ್ಲಿ",
  "ல",
]);

/**
 * The words that make a request out of "{Language} mein …": an imperative or a polite "can you"
 * ("jawab DO", "baat KARO", "BOLO", "sollunga", "cheppandi", "heli", "kar SAKTE ho?"). A statement
 * ("biwi marathi mein baat KARTI hai") carries none of them.
 */
const REQUEST_VERBS = wordSet([
  // Hindi / Hinglish
  "do",
  "dijiye",
  "dijie",
  "dena",
  "de",
  "dedo",
  "karo",
  "kariye",
  "kijiye",
  "karein",
  "karen",
  "kare",
  "karenge",
  "karna",
  "karni",
  "bolo",
  "boliye",
  "bolie",
  "bolna",
  "bolenge",
  "likho",
  "likhiye",
  "batao",
  "bataiye",
  "bataye",
  "samjhao",
  "samjhaiye",
  "sakte",
  "sakta",
  "sakti",
  "sakoge",
  "sakenge",
  "reply",
  "answer",
  "please",
  "pls",
  "plz",
  // Marathi
  "bola",
  "sanga",
  "sangaa",
  "dya",
  "dyaa",
  "uttar",
  // Gujarati
  "apo",
  "aapo",
  "kaho",
  // Tamil
  "sollunga",
  "sollu",
  "pesunga",
  "pesu",
  "pesungal",
  "pannunga",
  // Telugu
  "cheppandi",
  "cheppu",
  "matladandi",
  "matladu",
  "ivvandi",
  // Kannada
  "heli",
  "helri",
  "helu",
  "maatadi",
  "mathadi",
  "maataadi",
  // Devanagari
  "दो",
  "दीजिए",
  "दीजिये",
  "दें",
  "करो",
  "करिए",
  "कीजिए",
  "करें",
  "बोलो",
  "बोलिए",
  "बोलिये",
  "बोला",
  "लिखो",
  "लिखिए",
  "बताओ",
  "बताइए",
  "समझाओ",
  "समझाइए",
  "सांगा",
  "द्या",
  "सकते",
  "सकती",
  "सकता",
  // Tamil, Telugu, Kannada, Gujarati scripts
  "சொல்லுங்கள்",
  "சொல்லுங்க",
  "சொல்லு",
  "பேசுங்கள்",
  "பேசுங்க",
  "பேசு",
  "చెప్పండి",
  "చెప్పు",
  "మాట్లాడండి",
  "మాట్లాడు",
  "ಹೇಳಿ",
  "ಹೇಳು",
  "ಮಾತಾಡಿ",
  "ಮಾತನಾಡಿ",
  "બોલો",
  "કહો",
  "આપો",
  "કરો",
]);

/** A speech verb written straight after the name: "marathi BOLO", "speak" handled apart. */
const DIRECT_VERBS = wordSet([
  "bolo",
  "boliye",
  "bolie",
  "bolna",
  "bola",
  "बोलो",
  "बोलिए",
  "बोलिये",
]);

/** "bol" + a "can you" modal straight after the name: "marathi bol sakte ho?". */
const BOL = wordSet(["bol", "बोल"]);
const MODALS = wordSet(["sakte", "sakta", "sakti", "sakoge", "sakenge", "सकते", "सकती", "सकता"]);

/** The English verbs of a request: "reply in Tamil", "can you answer in Telugu", "speak English". */
const ENGLISH_REQUEST_VERBS = wordSet([
  "reply",
  "respond",
  "answer",
  "speak",
  "talk",
  "write",
  "chat",
  "tell",
  "explain",
  "say",
  "text",
  "continue",
  "communicate",
]);
/** The verbs that may take the language straight after them: "speak English", "reply Tamil". */
const ENGLISH_DIRECT_VERBS = wordSet(["speak", "reply", "answer", "respond", "write"]);
const ENGLISH_IN = wordSet(["in", "into"]);

/** "please" on its own beside a name: "Tamil please", "in Tamil please". */
const PLEASE = wordSet(["please", "pls", "plz"]);

/**
 * A NEGATION inside the request turns it into its opposite: "english mein MAT bolo", "english
 * mein NAHI", "DONT reply in English". Not "na", which is Hinglish's "please" tag ("bolo na").
 */
const NEGATIONS = wordSet([
  "mat",
  "mt",
  "nahi",
  "nahin",
  "nhi",
  "nai",
  "no",
  "not",
  "dont",
  "never",
  "nako",
  "nakko",
  "nathi",
  "vendam",
  "venda",
  "vaddu",
  "beda",
  "मत",
  "नहीं",
  "नही",
  "नको",
]);

/** A request is a short message; a long one that names a language is talking ABOUT it. */
const REQUEST_MAX_TOKENS = 12;
/** How far a request's verb, or a negation, may sit from the name. */
const REQUEST_WINDOW = 4;

/** Any token of `set` in `tokens[from, to)`. */
function anyIn(tokens: readonly string[], set: ReadonlySet<string>, from: number, to: number) {
  return tokens.slice(Math.max(0, from), Math.max(0, to)).some((token) => set.has(token));
}

/**
 * Is the language named at `i` the object of a request? Its three shapes:
 *   - LOCATIVE: "{L} mein [verb]" (or a glued "marathit [verb]") — the name followed by "in", then
 *     nothing at all ("marathi mein") or a request verb within the window ("jawab do", "bolo");
 *     a verb said BEFORE the name counts too when nothing follows ("jawab marathi mein");
 *   - DIRECT: "{L} bolo", "{L} bol sakte ho", "{L} please";
 *   - ENGLISH: "[verb] in {L}" / "speak {L}" / "in {L} please".
 * A negation after the name ("mat bolo", "nahi") or before an English verb ("dont reply") cancels it.
 */
function requestsAt(tokens: readonly string[], i: number, glued: boolean): boolean {
  const next = tokens[i + 1];
  const prev = tokens[i - 1];
  if (anyIn(tokens, NEGATIONS, i + 1, i + 1 + REQUEST_WINDOW)) return false;

  const afterLocative = glued ? i + 1 : next !== undefined && LOCATIVES.has(next) ? i + 2 : null;
  if (afterLocative !== null) {
    if (afterLocative >= tokens.length) return true;
    return anyIn(tokens, REQUEST_VERBS, afterLocative, afterLocative + REQUEST_WINDOW);
  }
  if (next !== undefined && (DIRECT_VERBS.has(next) || PLEASE.has(next))) return true;
  if (next !== undefined && BOL.has(next) && tokens[i + 2] !== undefined) {
    return MODALS.has(tokens[i + 2]!);
  }

  // English: the verb before the name, never negated in the words before it.
  if (prev === undefined) return false;
  const verbAt = ENGLISH_DIRECT_VERBS.has(prev)
    ? i - 1
    : ENGLISH_IN.has(prev)
      ? findLast(tokens, ENGLISH_REQUEST_VERBS, i - 1 - REQUEST_WINDOW, i - 1)
      : -1;
  if (verbAt >= 0) return !anyIn(tokens, NEGATIONS, verbAt - 2, verbAt);
  // "in Tamil please", "please, in Tamil" — a short ask with nothing else in it.
  return (
    ENGLISH_IN.has(prev) && tokens.length <= REQUEST_WINDOW && tokens.some((t) => PLEASE.has(t))
  );
}

/** The last index in `[from, to)` whose token is in `set`, or -1. */
function findLast(tokens: readonly string[], set: ReadonlySet<string>, from: number, to: number) {
  for (let j = to - 1; j >= Math.max(0, from); j--) if (set.has(tokens[j]!)) return j;
  return -1;
}

/**
 * AN EXPLICIT REQUEST TO REPLY IN A LANGUAGE (R41), or null. Phrased in Hinglish ("marathi mai
 * jawab do", "tamil me bolo", "english mein baat karo", "hindi mein bolo" → `hinglish`), in English
 * ("reply in Tamil", "speak English", "can you answer in Telugu") or in the language itself
 * ("marathit bola", "gujarati ma bolo", "Tamil-la sollunga", "telugu lo cheppandi",
 * "kannadadalli heli"), in Latin letters or the language's script.
 *
 * NOT a request: a message that only mentions a language ("main marathi hoon", "tamil nadu mein
 * kaam", "mujhe english nahi aati"), a long message about one, or a negated one ("english mein mat
 * bolo"). When a message names two, the first one asked for wins ("english mein nahi, hindi mein
 * bolo" asks for Hindi).
 */
export function parseLanguageRequest(text: string): FreeChatReplyLanguage | null {
  const tokens = languageTokens(text);
  if (tokens.length === 0 || tokens.length > REQUEST_MAX_TOKENS) return null;
  for (let i = 0; i < tokens.length; i++) {
    const named = NAME_INDEX.get(tokens[i]!);
    if (named !== undefined && requestsAt(tokens, i, named.glued)) return named.language;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The ask's answer, typed (R41): "Haan" / "Nahi" in the worker's own words
// ---------------------------------------------------------------------------

/**
 * A typed YES to "Kya aage ki saari baat {Language} mein karein?" — Hindi, English and each
 * regional language's own yes (Marathi "ho" / "hoy", Tamil "aam", Telugu "avunu", Kannada
 * "haudu"…), in Latin letters and in script.
 */
export const LANGUAGE_YES_WORDS = wordSet([
  "haan",
  "han",
  "haa",
  "ha",
  "haanji",
  "hanji",
  "ji",
  "jee",
  "yes",
  "yeah",
  "yep",
  "yup",
  "ya",
  "ok",
  "okay",
  "okk",
  "sure",
  "theek",
  "thik",
  "bilkul",
  "zaroor",
  "jaroor",
  "chalo",
  "chalega",
  "chaliye",
  "accha",
  "acha",
  "achha",
  "ho",
  "hoy",
  "hoye",
  "hoi",
  "aam",
  "aama",
  "aamaa",
  "ama",
  "amaa",
  "sari",
  "seri",
  "avunu",
  "avnu",
  "sare",
  "haudu",
  "houdu",
  "howdu",
  "हाँ",
  "हां",
  "हा",
  "हो",
  "होय",
  "जी",
  "ठीक",
  "ओके",
  "बिलकुल",
  "ज़रूर",
  "जरूर",
  "હા",
  "હો",
  "ஆமா",
  "ஆமாம்",
  "சரி",
  "అవును",
  "సరే",
  "ಹೌದು",
  "ಸರಿ",
]);

/** A typed NO — the same languages' own "no" / "not wanted". */
export const LANGUAGE_NO_WORDS = wordSet([
  "nahi",
  "nahin",
  "nhi",
  "nai",
  "na",
  "naa",
  "no",
  "nope",
  "nah",
  "mat",
  "nako",
  "nakko",
  "nathi",
  "illa",
  "illai",
  "vendam",
  "venda",
  "vendaam",
  "ledu",
  "vaddu",
  "vaddhu",
  "beda",
  "bedi",
  "नहीं",
  "नही",
  "ना",
  "नको",
  "नाही",
  "मत",
  "ના",
  "નથી",
  "இல்லை",
  "வேண்டாம்",
  "లేదు",
  "వద్దు",
  "ಇಲ್ಲ",
  "ಬೇಡ",
]);

/** A typed answer is a short reply; anything longer is a message, and the offer lapses. */
export const LANGUAGE_ANSWER_MAX_TOKENS = 4;

/**
 * A TYPED answer to the ask for `offer`, or null — the chip's key and label are read by the
 * router beside the other chips. A yes STARTS with a yes word and carries no "no"; a no starts
 * with a "no" and carries no yes; either is at most {@link LANGUAGE_ANSWER_MAX_TOKENS} words, and
 * NAMES NO OTHER LANGUAGE ("haan, tamil mein" to a Marathi ask is a new request, not a yes).
 */
export function readTypedLanguageAnswer(
  text: string,
  offer: FreeChatReplyLanguage,
): "yes" | "no" | null {
  const tokens = languageTokens(text);
  if (tokens.length === 0 || tokens.length > LANGUAGE_ANSWER_MAX_TOKENS) return null;
  if (tokens.some((token) => (languageNamed(token) ?? offer) !== offer)) return null;
  const first = tokens[0]!;
  const yes = tokens.some((token) => LANGUAGE_YES_WORDS.has(token));
  const no = tokens.some((token) => LANGUAGE_NO_WORDS.has(token));
  if (LANGUAGE_YES_WORDS.has(first) && !no) return "yes";
  if (LANGUAGE_NO_WORDS.has(first) && !yes) return "no";
  return null;
}
