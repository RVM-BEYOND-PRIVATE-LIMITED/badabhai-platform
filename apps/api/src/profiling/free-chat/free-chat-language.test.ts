import { describe, expect, it } from "vitest";
import type { FreeChatReplyLanguage } from "@badabhai/types";

import {
  detectReplyLanguage,
  languageNamed,
  languageTokens,
  parseLanguageRequest,
  readTypedLanguageAnswer,
} from "./free-chat-language";

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

  it("every regional script decides its language on its own, one word is enough", () => {
    expect(detectReplyLanguage("ವೇತನ")).toBe("kannada");
    expect(detectReplyLanguage("வேலை")).toBe("tamil");
    expect(detectReplyLanguage("ఉద్యోగం")).toBe("telugu");
    expect(detectReplyLanguage("નોકરી")).toBe("gujarati");
  });

  it("a zero-width joiner inside a word does not split it", () => {
    expect(detectReplyLanguage("मला नोकरी पाहि‍जे")).toBe("marathi");
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
  "dont reply in english",
  "don't speak hindi",
  // Too long to be a request: a message ABOUT a language
  "mere bhai ne kaha ki marathi mein baat karo par mujhe hindi aati hai aur main yahin rehta hoon",
  // Nothing to do with language at all
  "",
  "hello",
  "welder ki salary kitni hai",
];

describe("parseLanguageRequest — an explicit request to reply in a language (R41)", () => {
  it.each(REQUESTS)("%j → %s", (text, expected) => {
    expect(parseLanguageRequest(text)).toBe(expected);
  });

  it.each(NOT_REQUESTS)("%j is not a request", (text) => {
    expect(parseLanguageRequest(text)).toBeNull();
  });

  it("names every member of the closed set — Hindi is `hinglish`", () => {
    const named = new Set(REQUESTS.map(([text]) => parseLanguageRequest(text)));
    expect([...named].sort()).toEqual(
      ["english", "gujarati", "hinglish", "kannada", "marathi", "tamil", "telugu"].sort(),
    );
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
    "haan marathi mein",
    "हाँ",
    "होय",
    "ಹೌದು",
    "ஆமா",
    "అవును",
  ])("%j to a Marathi ask is yes", (text) => {
    expect(readTypedLanguageAnswer(text, "marathi")).toBe("yes");
  });

  it.each(["nahi", "no", "nako", "illa", "vendam", "ledu", "beda", "nahi rehne do", "नहीं", "ना"])(
    "%j is no",
    (text) => {
      expect(readTypedLanguageAnswer(text, "marathi")).toBe("no");
    },
  );

  it.each([
    // Another language named: a new request, not an answer.
    "haan tamil mein",
    "nahi hindi mein",
    // Both at once.
    "haan nahi",
    // Too long: a message, the offer lapses.
    "haan aur welder ki salary kitni hai",
    // Neither — a Telugu yes misspelt in Tamil script is not on any list.
    "kaise ho",
    "அவுனு",
    "",
  ])("%j to a Marathi ask is neither", (text) => {
    expect(readTypedLanguageAnswer(text, "marathi")).toBeNull();
  });
});
