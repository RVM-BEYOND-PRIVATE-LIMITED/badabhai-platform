import { describe, expect, it } from "vitest";
import type { FreeChatReplyLanguage } from "@badabhai/types";

import {
  detectReplyLanguage,
  languageNamed,
  languageTokens,
  parseLanguageRequest,
  readTypedLanguageAnswer,
} from "./free-chat-language";
import {
  ENGLISH_LATIN_WORDS,
  HINDI_DEVANAGARI_WORDS,
  HINDI_LATIN_WORDS,
  HINDI_SHARED_WORDS,
  MARATHI_DEVANAGARI_WORDS,
  REGIONAL_LATIN_WORDS,
} from "./free-chat-language.lexicon";

/**
 * ADR-0051 §11 (R39–R41) — the reply language, decided by code. Every line below is FABRICATED for
 * this suite: no worker's words. Each block is a corpus the detector or the parser must read, and
 * the false-friend block is the one that keeps the word lists honest: a word two languages share
 * decides nothing.
 */

type Case = readonly [text: string, expected: FreeChatReplyLanguage];

// ---------------------------------------------------------------------------
// detectReplyLanguage — the language a message is written in (R40)
// ---------------------------------------------------------------------------

const ENGLISH: readonly Case[] = [
  ["How are you?", "english"],
  ["I am a welder from Pune", "english"],
  ["What is the salary of a CNC operator in Pune?", "english"],
  ["Can you tell me how to get a job in Dubai?", "english"],
  ["I want to learn welding, where should I start?", "english"],
  ["Which course is best for an electrician?", "english"],
  ["Is there any work for a fitter here?", "english"],
  ["I need a job", "english"],
  ["What should I do now", "english"],
  ["Kay is my friend and I need a job", "english"],
];

const HINGLISH_LATIN: readonly Case[] = [
  ["kaise ho aap", "hinglish"],
  ["mujhe welder ki job chahiye", "hinglish"],
  ["salary kitni milti hai", "hinglish"],
  ["main electrician hoon, kaam chahiye", "hinglish"],
  ["aaj mausam kaisa hai", "hinglish"],
  ["kya haal hai", "hinglish"],
  ["I want job, kya karu", "hinglish"],
  ["mera experience 5 saal ka hai", "hinglish"],
  ["Dubai mein kaam milega kya?", "hinglish"],
];

const HINDI_DEVANAGARI: readonly Case[] = [
  ["मुझे नौकरी चाहिए", "hinglish"],
  ["आप कैसे हैं?", "hinglish"],
  ["वेल्डर की सैलरी कितनी है?", "hinglish"],
  ["मैं इलेक्ट्रीशियन हूँ और काम ढूँढ रहा हूँ", "hinglish"],
];

const MARATHI: readonly Case[] = [
  ["mala kaam pahije", "marathi"],
  ["tumhi kase aahat?", "marathi"],
  ["mala CNC operator chi job pahije, kay karu?", "marathi"],
  ["majha pagar kiti asel?", "marathi"],
  ["kuthe kaam milel?", "marathi"],
  ["mala welding shikaychi aahe", "marathi"],
  ["मला नोकरी पाहिजे", "marathi"],
  ["तुम्ही कसे आहात?", "marathi"],
  ["मला काम पाहिजे आहे", "marathi"],
  ["वेल्डरला पगार किती मिळेल?", "marathi"],
];

const GUJARATI: readonly Case[] = [
  ["kem cho", "gujarati"],
  ["tame kem cho?", "gujarati"],
  ["mare nokri joie chhe", "gujarati"],
  ["mane welding shikhvu che", "gujarati"],
  ["મને નોકરી જોઈએ છે", "gujarati"],
  ["તમે કેમ છો?", "gujarati"],
];

const TAMIL: readonly Case[] = [
  ["enakku velai venum", "tamil"],
  ["eppadi irukeenga", "tamil"],
  ["sambalam evlo kidaikkum?", "tamil"],
  ["naan welder, enakku Chennai la vela venum", "tamil"],
  ["எனக்கு வேலை வேணும்", "tamil"],
  ["சம்பளம் எவ்வளவு?", "tamil"],
  ["நான் CNC operator, எனக்கு job வேணும்", "tamil"],
];

const TELUGU: readonly Case[] = [
  ["naaku job kavali", "telugu"],
  ["meeru ela unnaru?", "telugu"],
  ["nenu electrician, naaku pani kavali", "telugu"],
  ["నాకు ఉద్యోగం కావాలి", "telugu"],
  ["మీరు ఎలా ఉన్నారు?", "telugu"],
];

const KANNADA: readonly Case[] = [
  ["nanage kelsa beku", "kannada"],
  ["neevu hege iddira?", "kannada"],
  ["sambala eshtu sigutte?", "kannada"],
  ["ನನಗೆ ಕೆಲಸ ಬೇಕು", "kannada"],
  ["ನೀವು ಹೇಗಿದ್ದೀರಾ?", "kannada"],
];

/** Too little evidence, and ties — the safe default, Hinglish (R40: "unsure → Hinglish"). */
const UNSURE: readonly Case[] = [
  ["", "hinglish"],
  ["   ", "hinglish"],
  ["ok", "hinglish"],
  ["hello", "hinglish"],
  ["hi", "hinglish"],
  ["\u{1F44D}", "hinglish"],
  ["?", "hinglish"],
  ["123", "hinglish"],
  ["Pune", "hinglish"],
  ["thanks", "hinglish"],
  // Greetings and acknowledgements prove nothing about the language.
  ["yes please", "hinglish"],
  ["ok thanks", "hinglish"],
  // A single marker word is too little evidence on its own.
  ["kay", "hinglish"],
  ["enakku", "hinglish"],
  // Only loanwords — no evidence either way.
  ["CNC operator salary", "hinglish"],
  // Two regional languages tied at the top.
  ["kem kay", "hinglish"],
  // Marathi and Hindi tied, in Latin and in Devanagari.
  ["mala chahiye", "hinglish"],
  ["मला चाहिए", "hinglish"],
  // Two regional scripts tied, one letter each (Tamil and Telugu "ma").
  ["ம మ", "hinglish"],
];

/** Words two languages share — each one decides nothing; the rest of the message decides. */
const FALSE_FRIENDS: readonly Case[] = [
  // "hai" in Marathi text: the Marathi markers still outweigh it.
  ["mala job pahije hai", "marathi"],
  ["मला नोकरी पाहिजे है", "marathi"],
  // "che" / "chhe" is Hinglish's sloppy "six" too: the Hindi markers outweigh it.
  ["mere paas che saal ka experience hai", "hinglish"],
  ["chhe mahine se kaam dhoond raha hoon", "hinglish"],
  ["che saal", "hinglish"],
  // "nahi" is Hindi AND Marathi: it decides nothing, the other words do.
  ["mala kaam nahi milala", "marathi"],
  ["mala nahi", "marathi"],
  ["mujhe kaam nahi mila", "hinglish"],
  ["nahi", "hinglish"],
  ["kaam nahi", "hinglish"],
  // "illa" is Tamil AND Kannada.
  ["velai illa", "tamil"],
  ["kelsa illa", "kannada"],
  ["illa illa", "hinglish"],
  // "thi" and "hu" are Gujarati ("from", "I") as much as Hindi ("was", "am").
  ["hu Surat thi chhu", "gujarati"],
  // "kela" is Marathi "did" and Hindi "banana".
  ["maine kela khaya", "hinglish"],
  // "karo" is a Gujarati imperative as much as a Hindi one.
  ["vaat karo tame", "gujarati"],
  // "kon" is Marathi "who"; "aata" is Marathi "now".
  ["aata kon aahe", "marathi"],
  // ONE regional marker in Hindi-shaped text decides nothing (L2): Hindi "vela" (idle) is Tamil
  // "vela" (work), but "hu" is a word Hindi shares with GUJARATI, and "main" with English.
  ["main vela baitha hu", "hinglish"],
  ["main vela baitha", "hinglish"],
  // Hindi "aaste aaste" (slowly) is Marathi "aste"; repeated, it is still ONE marker, and "karo"
  // is Hindi and Gujarati.
  ["aste aste kaam karo", "hinglish"],
  // Two DISTINCT markers still decide, whatever the Hindi-shaped words beside them.
  ["mala kaam karaycha aahe", "marathi"],
];

/** Devanagari punctuation and digits belong to no language (L4). */
const SCRIPT_NEUTRAL: readonly Case[] = [
  ["I want a job in Pune\u0964", "english"],
  ["I want a job in Pune\u0965", "english"],
  ["My salary is \u0968\u0966\u0966\u0966\u0966", "english"],
  ["\u0967\u0968\u0969", "hinglish"],
  // A Devanagari LETTER still decides.
  ["मुझे नौकरी चाहिए\u0964", "hinglish"],
  ["मला नोकरी पाहिजे\u0964", "marathi"],
];

/** A script mixed with Latin loanwords: the script decides, the loanwords do not. */
const MIXED_SCRIPT: readonly Case[] = [
  ["मला CNC job पाहिजे", "marathi"],
  ["मुझे CNC job चाहिए", "hinglish"],
  ["Pune madhe ನನಗೆ ಕೆಲಸ ಬೇಕು", "kannada"],
  // The Kannada script outweighs one Devanagari word.
  ["ನನಗೆ ಕೆಲಸ ಬೇಕು है", "kannada"],
];

describe("detectReplyLanguage — the language each message is written in (R39, R40)", () => {
  it.each(ENGLISH)("English %j → %s", (text, expected) => {
    expect(detectReplyLanguage(text)).toBe(expected);
  });
  it.each(HINGLISH_LATIN)("Hinglish (Latin) %j → %s", (text, expected) => {
    expect(detectReplyLanguage(text)).toBe(expected);
  });
  it.each(HINDI_DEVANAGARI)("Hindi (Devanagari) %j → %s", (text, expected) => {
    expect(detectReplyLanguage(text)).toBe(expected);
  });
  it.each(MARATHI)("Marathi %j → %s", (text, expected) => {
    expect(detectReplyLanguage(text)).toBe(expected);
  });
  it.each(GUJARATI)("Gujarati %j → %s", (text, expected) => {
    expect(detectReplyLanguage(text)).toBe(expected);
  });
  it.each(TAMIL)("Tamil %j → %s", (text, expected) => {
    expect(detectReplyLanguage(text)).toBe(expected);
  });
  it.each(TELUGU)("Telugu %j → %s", (text, expected) => {
    expect(detectReplyLanguage(text)).toBe(expected);
  });
  it.each(KANNADA)("Kannada %j → %s", (text, expected) => {
    expect(detectReplyLanguage(text)).toBe(expected);
  });
  it.each(UNSURE)("too little evidence, or a tie: %j → %s", (text, expected) => {
    expect(detectReplyLanguage(text)).toBe(expected);
  });
  it.each(FALSE_FRIENDS)("a false friend decides nothing: %j → %s", (text, expected) => {
    expect(detectReplyLanguage(text)).toBe(expected);
  });
  it.each(MIXED_SCRIPT)("a script beside Latin loanwords: %j → %s", (text, expected) => {
    expect(detectReplyLanguage(text)).toBe(expected);
  });
  it.each(SCRIPT_NEUTRAL)("the danda and the digits decide nothing: %j → %s", (text, expected) => {
    expect(detectReplyLanguage(text)).toBe(expected);
  });

  it("every regional script decides its language on its own, one word is enough", () => {
    expect(detectReplyLanguage("ವೇತನ")).toBe("kannada");
    expect(detectReplyLanguage("வேலை")).toBe("tamil");
    expect(detectReplyLanguage("ఉద్యోగం")).toBe("telugu");
    expect(detectReplyLanguage("નોકરી")).toBe("gujarati");
  });

  it("a zero-width joiner inside a word does not split it", () => {
    expect(detectReplyLanguage("मला नोकरी पाहि\u200dजे")).toBe("marathi");
  });

  it("covers every member of the closed set across the corpus", () => {
    const seen = new Set(
      [...ENGLISH, ...HINGLISH_LATIN, ...MARATHI, ...GUJARATI, ...TAMIL, ...TELUGU, ...KANNADA].map(
        ([text]) => detectReplyLanguage(text),
      ),
    );
    expect([...seen].sort()).toEqual(
      ["english", "gujarati", "hinglish", "kannada", "marathi", "tamil", "telugu"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// parseLanguageRequest — an explicit request (R41)
// ---------------------------------------------------------------------------

const REQUESTS: readonly Case[] = [
  // Hinglish
  ["marathi mai jawab do", "marathi"],
  ["Marathi mein jawab do", "marathi"],
  ["tamil me bolo", "tamil"],
  ["english mein baat karo", "english"],
  ["hindi mein bolo", "hinglish"],
  ["gujarati mein samjhaiye", "gujarati"],
  ["telugu mein reply karo", "telugu"],
  ["kannada me batao", "kannada"],
  ["kya aap marathi mein baat kar sakte hain?", "marathi"],
  ["marathi bol sakte ho?", "marathi"],
  ["marathi bolo", "marathi"],
  ["jawab marathi mein", "marathi"],
  ["nahi samjha, marathi mein bolo", "marathi"],
  ["english mein nahi, hindi mein bolo", "hinglish"],
  ["marathi mein", "marathi"],
  ["marathi mein samjhaiye na", "marathi"],
  ["angrezi mein batao", "english"],
  ["mujhe english mein baat karni hai", "english"],
  ["Tamil please", "tamil"],
  ["Haan, Tamil mein", "tamil"],
  // English
  ["reply in Tamil", "tamil"],
  ["speak English", "english"],
  ["can you answer in Telugu", "telugu"],
  ["please talk to me in Kannada", "kannada"],
  ["Can you speak Marathi?", "marathi"],
  ["in Gujarati please", "gujarati"],
  ["explain in hindi", "hinglish"],
  ["tell me in english", "english"],
  // The regional languages themselves
  ["marathit bola", "marathi"],
  ["marathit uttar dya", "marathi"],
  ["marathi madhe sanga", "marathi"],
  ["gujarati ma bolo", "gujarati"],
  ["gujaratima vaat karo", "gujarati"],
  ["Tamil-la sollunga", "tamil"],
  ["tamil la pesunga", "tamil"],
  ["tamizhil sollunga", "tamil"],
  ["telugu lo cheppandi", "telugu"],
  ["telugulo matladandi", "telugu"],
  ["kannadadalli heli", "kannada"],
  ["kannada dalli maatadi", "kannada"],
  // In script
  ["मराठी में जवाब दो", "marathi"],
  ["मराठीत बोला", "marathi"],
  ["हिंदी में बोलो", "hinglish"],
  // The nukta precomposed (U+095B): NFC reads it as the decomposed spelling the list holds.
  ["अंग्रेज़ी में बात करो", "english"],
  ["ગુજરાતીમાં બોલો", "gujarati"],
  ["தமிழில் சொல்லுங்கள்", "tamil"],
  ["తెలుగులో చెప్పండి", "telugu"],
  ["ಕನ್ನಡದಲ್ಲಿ ಹೇಳಿ", "kannada"],
];

const NOT_REQUESTS: readonly string[] = [
  // Merely MENTIONS a language
  "main marathi hoon",
  "tamil nadu mein kaam",
  "mujhe english nahi aati",
  "telugu movie dekhi",
  "kannada sikhna hai",
  "english seekhni hai",
  "marathi log bahut acche hain",
  "do you know tamil",
  "I am from Tamil Nadu",
  "my mother tongue is marathi",
  "my english is weak",
  "english mein kya kehte hain",
  "marathi mein kaam chahiye",
  "meri biwi marathi mein baat karti hai",
  "main marathi bolta hoon",
  "marathi",
  "தமிழ்நாடு வேலை",
  // Negated
  "english mein mat bolo",
  "marathi mein baat mat karo",
  "english mein bolo mat",
  "dont reply in english",
  "don't speak hindi",
  "do not reply in english",
  // A negation of the request verb or the named language, wherever it sits (low a)
  "mat english mein bolo",
  "english mein reply nahi karna",
  "english mein baat nahi karni",
  "tamil la sollunga vendam",
  // A GENERIC verb beside content is not aimed at the reply (B2 / H1)
  "tamil me kaam karna hai",
  "mujhe tamil me job dedo",
  "gujarati mein job batao",
  "english mein resume bana do",
  "hindi mein resume bana dijiye",
  "ye marathi mein hai",
  // A place, not a language
  "can you tell me about jobs in tamil nadu",
  // Too long to be a request: a message ABOUT a language
  "mere bhai ne kaha ki marathi mein baat karo par mujhe hindi aati hai aur main yahin rehta hoon",
  // Nothing to do with language at all
  "",
  "hello",
  "welder ki salary kitni hai",
];

describe("parseLanguageRequest — an explicit request to reply in a language (R41)", () => {
  it.each(REQUESTS)("%j → %s", (text, expected) => {
    expect(parseLanguageRequest(text)?.language).toBe(expected);
  });

  it.each(NOT_REQUESTS)("%j is not a request", (text) => {
    expect(parseLanguageRequest(text)).toBeNull();
  });

  it("names every member of the closed set — Hindi is `hinglish`", () => {
    const named = new Set(REQUESTS.map(([text]) => parseLanguageRequest(text)?.language));
    expect([...named].sort()).toEqual(
      ["english", "gujarati", "hinglish", "kannada", "marathi", "tamil", "telugu"].sort(),
    );
  });

  it("a negation AFTER the request is another clause — only one of the request cancels it (L1)", () => {
    expect(parseLanguageRequest("english mein bolo, hindi nahi aati")).toEqual({
      language: "english",
      bare: false,
    });
    expect(parseLanguageRequest("english mein bolo, mujhe hindi nahi aati")?.language).toBe(
      "english",
    );
  });
});

/** A BARE request: every word is the request's own — the only kind that skips the classifier. */
const BARE_REQUESTS: readonly Case[] = [
  ["marathi mai jawab do", "marathi"],
  ["Marathi mein jawab do", "marathi"],
  ["tamil me bolo", "tamil"],
  ["kannada me batao", "kannada"],
  ["kya aap marathi mein baat kar sakte hain?", "marathi"],
  ["marathi bol sakte ho?", "marathi"],
  // A negation may sit in a bare request only where it negates ANOTHER named language (low c).
  ["english mein nahi, hindi mein bolo", "hinglish"],
  ["reply in english not hindi", "english"],
  ["mat hindi, english mein bolo", "english"],
  ["tamil la sollunga, english vendam", "tamil"],
  ["mujhe english mein baat karni hai", "english"],
  ["Haan, Tamil mein", "tamil"],
  ["jawab marathi mein", "marathi"],
  ["please talk to me in Kannada", "kannada"],
  ["Can you speak Marathi?", "marathi"],
  ["from now on reply in tamil only", "tamil"],
  ["marathit uttar dya", "marathi"],
  ["Tamil-la sollunga", "tamil"],
  ["telugu lo cheppandi", "telugu"],
  ["kannadadalli heli", "kannada"],
  ["मराठी में जवाब दो", "marathi"],
  ["தமிழில் சொல்லுங்கள்", "tamil"],
];

/**
 * A request WITH SOMETHING ELSE IN IT — still a request (its language rides a casual or career
 * reply), but not bare, so the classifier reads it: a question, a jobs ask, distress, abuse.
 */
const NOT_BARE_REQUESTS: readonly Case[] = [
  ["can you tell me in tamil what is welder salary", "tamil"],
  ["english mein bolo, hindi nahi aati", "english"],
  ["reply in english, i want to die", "english"],
  ["मराठीत सांगा, मला जगायचं नाही", "marathi"],
  ["telugu lo cheppandi naaku chavalani undi", "telugu"],
  ["english mein bolo, khud ko khatam kar lunga", "english"],
  ["tamil la sollunga, saala kutta", "tamil"],
  ["marathi mein bolo, welder ki salary kitni hai", "marathi"],
  // A negation about SOMETHING ELSE: the request stands, the classifier reads the rest (low c).
  ["nahi samjha, marathi mein bolo", "marathi"],
  ["hindi mein bolo, ab kya hi karna hai, ab aage nahi", "hinglish"],
  ["reply in english, can not continue", "english"],
  ["no, reply in tamil", "tamil"],
];

/** Negations with no language named, or about the worker themself: never a bare request (low c). */
const NEGATED_NOT_BARE: readonly string[] = [
  "mujhse nahi ho",
  "mujhe ab baat nahi karni",
  "mala nako",
  "enakku vendam",
  "naaku vaddu",
];

describe("parseLanguageRequest — a BARE request skips the classifier, any other is classified (B2 / H1)", () => {
  it.each(BARE_REQUESTS)("%j is a bare request for %s", (text, expected) => {
    expect(parseLanguageRequest(text)).toEqual({ language: expected, bare: true });
  });

  it.each(NOT_BARE_REQUESTS)("%j asks for %s, and is NOT bare", (text, expected) => {
    expect(parseLanguageRequest(text)).toEqual({ language: expected, bare: false });
  });

  it.each(NEGATED_NOT_BARE)("%j is no bare request — it is classified", (text) => {
    expect(parseLanguageRequest(text)?.bare ?? false).toBe(false);
  });

  it("a format character never splits a word into grammar words (low b)", () => {
    // U+200B between "jee" and "na": one word, "jeena" — not the fillers "jee" and "na".
    const zwsp = "hindi mein bolo, ab jee\u200Bna nahi";
    expect(parseLanguageRequest(zwsp)).toEqual({ language: "hinglish", bare: false });
    expect(languageTokens(zwsp)).toContain("jeena");
    // The soft hyphen, a bidi override and a BOM are dropped too.
    expect(languageTokens("ma\u00ADrathi me\u202Ein bo\uFEFFlo")).toEqual([
      "marathi",
      "mein",
      "bolo",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The tokenizer and the name index
// ---------------------------------------------------------------------------

describe("languageTokens and languageNamed", () => {
  it("keeps an Indic word whole — its vowel signs are part of it", () => {
    expect(languageTokens("मराठी में!")).toEqual(["मराठी", "में"]);
    expect(languageTokens("தமிழில், சொல்லுங்கள்")).toEqual(["தமிழில்", "சொல்லுங்கள்"]);
  });

  it("lowercases, drops apostrophes and splits on punctuation", () => {
    expect(languageTokens("Don't — Tamil-la, PLEASE")).toEqual(["dont", "tamil", "la", "please"]);
  });

  it("names a language bare or with 'in' glued on, and nothing for a prefix-only match", () => {
    expect(languageNamed("Marathi")).toBe("marathi");
    expect(languageNamed("marathit")).toBe("marathi");
    expect(languageNamed("hindi")).toBe("hinglish");
    expect(languageNamed("தமிழ்நாடு")).toBeNull();
    expect(languageNamed("pune")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readTypedLanguageAnswer — the ask's yes / no, typed
// ---------------------------------------------------------------------------

describe("readTypedLanguageAnswer — a typed yes or no to the ask", () => {
  it.each([
    "haan",
    "ha",
    "Haa",
    "yes",
    "ho",
    "hoy",
    "aam",
    "avunu",
    "haudu",
    "ok",
    "theek hai",
    "haan ji",
    "ji haan",
    "ji",
    "haan marathi mein",
    "Haan, Marathi mein",
    "ok marathit",
    "theek hai marathi mein",
    "हाँ",
    "होय",
    "ಹೌದು",
    "ஆமா",
    "అవును",
  ])("%j to a Marathi ask is yes", (text) => {
    expect(readTypedLanguageAnswer(text, "marathi")).toBe("yes");
  });

  it.each([
    "nahi",
    "no",
    "nako",
    "illa",
    "vendam",
    "ledu",
    "beda",
    "नहीं",
    "ना",
    "nahi ji",
    "ji nahi",
    "nahi marathi mein",
  ])("%j is no", (text) => {
    expect(readTypedLanguageAnswer(text, "marathi")).toBe("no");
  });

  it.each([
    // Another language named: a new request, not an answer.
    "haan tamil mein",
    "nahi hindi mein",
    // Both at once.
    "haan nahi",
    // Too long: a message, the offer lapses.
    "haan aur welder ki salary kitni hai",
    // A yes / no word leading a MESSAGE is no answer (M1): anything beyond the offered language's
    // name, "mein" and "ji" lets the offer lapse, and the classifier reads the message.
    "accha salary kitni hai",
    "ok, salary batao",
    "ho gaya",
    "haan marna hai",
    "nahi jeena mujhe",
    "illai vaazha venam",
    "nahi rehne do",
    "haan haan bilkul theek",
    // Neither — a Telugu yes misspelt in Tamil script is not on any list.
    "kaise ho",
    "அவுனு",
    "",
  ])("%j to a Marathi ask is neither", (text) => {
    expect(readTypedLanguageAnswer(text, "marathi")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The lexicon's own invariants
// ---------------------------------------------------------------------------

/** A list as its normalized words — the form the logic module's sets hold. */
const normalized = (words: readonly string[]) =>
  words.map((word) => word.normalize("NFC").toLowerCase());

describe("the lexicon — a shared word belongs to NO marker list (L3)", () => {
  const latinLists: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["hindi", HINDI_LATIN_WORDS],
    ["english", ENGLISH_LATIN_WORDS],
    ...Object.entries(REGIONAL_LATIN_WORDS),
  ];

  it("no Latin marker appears in two languages' lists", () => {
    const owners = new Map<string, string[]>();
    for (const [language, words] of latinLists) {
      for (const word of new Set(normalized(words))) {
        owners.set(word, [...(owners.get(word) ?? []), language]);
      }
    }
    const shared = [...owners].filter(([, languages]) => languages.length > 1);
    expect(shared).toEqual([]);
  });

  it("no Devanagari marker is both Marathi and Hindi", () => {
    const hindi = new Set(normalized(HINDI_DEVANAGARI_WORDS));
    expect(normalized(MARATHI_DEVANAGARI_WORDS).filter((word) => hindi.has(word))).toEqual([]);
  });

  it("no word Hindi shares is a marker of any language — it is evidence for neither", () => {
    const markers = new Set(latinLists.flatMap(([, words]) => normalized(words)));
    const sharedWords = Object.values(HINDI_SHARED_WORDS).flatMap((words) => normalized(words));
    expect(sharedWords.filter((word) => markers.has(word))).toEqual([]);
  });

  it("'hogi' is Hindi alone", () => {
    expect(REGIONAL_LATIN_WORDS.kannada).not.toContain("hogi");
    expect(HINDI_LATIN_WORDS).toContain("hogi");
  });
});

describe("a 4,000-character message (L9)", () => {
  const inputs = [
    "mala kaam bolo tamil me ".repeat(200).slice(0, 4000),
    // One unbroken Devanagari "word", and one of apostrophes and joiners: the regex worst cases.
    "म".repeat(4000),
    "'\u200d".repeat(2000),
  ];

  it("every reader answers in linear time, well under the turn's budget", () => {
    for (const long of inputs) expect(long.length).toBe(4000);
    const started = performance.now();
    for (let i = 0; i < 20; i++) {
      for (const long of inputs) {
        detectReplyLanguage(long);
        parseLanguageRequest(long);
        readTypedLanguageAnswer(long, "marathi");
      }
    }
    // Twenty rounds of all three readers on each input, generously bounded for a loaded CI runner.
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(parseLanguageRequest(inputs[0]!)).toBeNull();
    expect(readTypedLanguageAnswer(inputs[0]!, "marathi")).toBeNull();
  }, 10_000);
});
