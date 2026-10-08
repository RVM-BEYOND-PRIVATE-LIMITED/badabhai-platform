import { describe, expect, it } from "vitest";

import { GENERAL_FORM_BRIEF_MAX_CHARS } from "@badabhai/types";

import {
  BRIEF_RAW_MAX_UNITS,
  BRIEF_REFUSAL_REASONS,
  briefLength,
  looksLikeMoney,
  readStoredBrief,
  screenBrief,
  type BriefRefusalReason,
} from "./general-form-brief";

/**
 * ═══ THE BRIEF SCREEN (ADR-0045 R6) ═══
 *
 * The brief prints under the headline on the EMPLOYER's copy, verbatim. Two lists carry this
 * file: what a real worker writes must pass (Hinglish, Devanagari, a degree with a dot in it), and
 * every shape that would put a contact route, an identifier or an employer on that page must be
 * refused — with the reason the app turns into a line the worker can act on.
 */

const accepted = (raw: string): string => {
  const result = screenBrief(raw, null);
  if (!result.ok) throw new Error(`refused (${result.reason}): ${JSON.stringify(raw)}`);
  return result.text;
};
const reasonOf = (raw: string, knownName: string | null = null): BriefRefusalReason | null => {
  const result = screenBrief(raw, knownName);
  return result.ok ? null : result.reason;
};

describe("screenBrief — what a real worker writes passes, verbatim", () => {
  it.each([
    "Main 8 saal se electrician ka kaam kar raha hoon, ghar aur dukaan ki wiring karta hoon.",
    "Graphic designer hoon, CorelDRAW aur Photoshop mein banner aur visiting card banata hoon.",
    "Hotel mein 3 saal cook raha, tandoor aur chinese dono aata hai.",
    // A degree with a dot is not a link: `.com` is exactly what the URL wall looks for.
    "B.Com pass, 2 saal se accounts aur Tally ka kaam karta hoon.",
    // Lower-case "limited" is prose, not an entity suffix.
    "ITI electrician, experience limited hai par seekhne ko taiyaar hoon.",
    // "Pvt company" names nobody — it is how a worker says "a private company".
    "Pvt company me 4 saal driver raha (heavy licence).",
    // Years joined by words are fine; see the known cost below for the hyphenated form.
    "Maine 2015 se 2023 tak kaam kiya.",
    // Five letters, a year, a one-letter word: the any-case PAN wall must not read prose as one.
    "Working since 2019 a good welder",
    // A "co-" compound is not a firm (#1914): the shared org wall no longer reads "and co-" as
    // "and Co". The firm forms stay refused, in the organisation cases below.
    "Line supervisor hoon, QC and co-workers ke saath co-ordinate karta hoon.",
  ])("%s", (raw) => {
    expect(accepted(raw)).toBe(raw);
  });

  it("Devanagari passes intact — matras, virama, chandrabindu and the danda survive", () => {
    const raw = "मैं 5 साल से वेल्डिंग का काम कर रहा हूँ।";
    expect(accepted(raw)).toBe(raw);
    expect(accepted("मैं दर्ज़ी हूँ, ब्लाउज़ और कुर्ता सिलता हूँ")).toBe(
      "मैं दर्ज़ी हूँ, ब्लाउज़ और कुर्ता सिलता हूँ".normalize("NFKC"),
    );
  });

  it("normalises before it measures: whitespace collapsed, ends trimmed, invisibles stripped", () => {
    expect(accepted("  Welder\n\nhoon,\t5 saal  ")).toBe("Welder hoon, 5 saal");
    // U+200B (zero-width space) and U+FE0F (variation selector) render as nothing.
    expect(accepted("Welder​ hoon️")).toBe("Welder hoon");
  });

  it("the 160 bound is measured on the COLLAPSED text, in code points", () => {
    const exact = "a".repeat(GENERAL_FORM_BRIEF_MAX_CHARS);
    expect(accepted(exact)).toBe(exact);
    // Padding does not count: 160 letters inside 200 spaces is a 160-character brief.
    expect(accepted(`${" ".repeat(100)}${exact}${" ".repeat(100)}`)).toBe(exact);
    expect(reasonOf(`${exact}a`)).toBe("too_long");
    // Devanagari is one code point per letter-part, the same measure the event records.
    const hindi = "क".repeat(GENERAL_FORM_BRIEF_MAX_CHARS);
    expect(briefLength(accepted(hindi))).toBe(GENERAL_FORM_BRIEF_MAX_CHARS);
  });
});

describe("screenBrief — refused whole, with a closed reason", () => {
  const CASES: readonly (readonly [string, BriefRefusalReason])[] = [
    // identifiers — hard identifiers, phone/email shapes, any-script digits, the digit budget
    ["Call me 98765 43210", "identifier"],
    ["मेरा नंबर ९८७६५४३२१० है", "identifier"],
    ["email ramesh@gmail.com", "identifier"],
    ["Aadhaar 1234 5678 9012", "identifier"],
    ["abcde1234f mera PAN", "identifier"],
    ["ABCDE 1234 F", "identifier"],
    ["9876543210", "identifier"],
    // contact routes the shared shapes miss
    ["UPI ramesh@okaxis", "contact"],
    ["ramesh at gmail dot com pe likho", "contact"],
    ["Insta pe @ramesh_cook", "contact"],
    // links
    ["Portfolio www.ramesh.in dekhiye", "link"],
    ["t.me/ramesh pe baat karo", "link"],
    ["linktr.ee/ramesh", "link"],
    ["https://example.org/cv", "link"],
    // organisations — the brief prints on the EMPLOYER copy (module header)
    ["Tata Motors Ltd mein 5 saal", "organisation"],
    ["tata motors ltd mein 5 saal", "organisation"],
    ["Sharma Pvt Ltd mein kaam kiya", "organisation"],
    ["Reliance Industries Limited mein supervisor", "organisation"],
    ["शर्मा प्राइवेट लिमिटेड में काम", "organisation"],
    // the shared "Co" forms after #1914's compound guard
    ["Sharma & Co mein fitter tha", "organisation"],
    ["Cosmos Co.op. Bank mein 5 saal security guard", "organisation"],
    // what the sheet cannot print
    ["Accha kaam karta hoon 🙂", "emoji"],
    ["Accha kaam 🇮🇳", "emoji"],
    ["Welder 👍🏽", "emoji"],
    ["[PERSON_1] ke saath kaam", "brackets"],
    ["<b>welder</b>", "brackets"],
    ["{{worker_name}} welder", "brackets"],
    // nothing to print
    ["", "empty"],
    ["   \n\t ", "empty"],
    ["....", "empty"],
    ["​​", "empty"],
  ];

  it.each(CASES)("%s → %s", (raw, reason) => {
    expect(reasonOf(raw)).toBe(reason);
  });

  it("a raw input over the ceiling is refused BEFORE any regex runs", () => {
    expect(reasonOf("a".repeat(BRIEF_RAW_MAX_UNITS + 1))).toBe("too_long");
    expect(reasonOf(" ".repeat(BRIEF_RAW_MAX_UNITS + 1))).toBe("too_long");
  });

  it("every reason the screen can give is a member of the closed set", () => {
    for (const [raw] of CASES) {
      const reason = reasonOf(raw);
      expect(reason === null || BRIEF_REFUSAL_REASONS.includes(reason)).toBe(true);
    }
  });
});

describe("screenBrief — known costs, pinned so nobody is surprised (module header)", () => {
  it("a hyphenated year range reads as a phone-shaped run", () => {
    expect(reasonOf("Maine 2015-2023 tak kaam kiya.")).toBe("identifier");
  });

  it("ten digits across the whole brief are refused, whatever separates them", () => {
    expect(reasonOf("10 saal, 2014 se, 15000 salary")).toBe("identifier");
  });

  it("a dotted qualification followed by a slash reads as a host with a path", () => {
    expect(reasonOf("Main B.Tech/Diploma hoon")).toBe("link");
  });

  it("a bare brand with no legal suffix passes — the shared heuristic cannot tell it from prose", () => {
    expect(reasonOf("Tata Motors mein 5 saal welding ki")).toBeNull();
  });
});

describe("screenBrief — the worker's OWN name (the employer copy prints only its initials)", () => {
  const NAME = "Ramesh Kumar Yadav";

  it.each([
    // The natural answer to "apne kaam ke baare mein batayein" is a self-introduction.
    "Mera naam Ramesh Kumar Yadav hai, 8 saal se welder hoon",
    "My name is Ramesh Kumar, I am a cook",
    // Any token of 3+ characters, any case, anywhere.
    "Ramesh - experienced cook",
    "yadav ji, 10 saal driver",
    "Main RAMESH hoon, electrician",
  ])("refuses %s as name", (raw) => {
    expect(reasonOf(raw, NAME)).toBe("name");
  });

  it("reads a dotted, hyphenated or apostrophe name, and a nukta variant, as the redactor does (#2166)", () => {
    expect(reasonOf("Suresh, 8 saal se welder", "K.Suresh")).toBe("name");
    expect(reasonOf("Ram Prasad, 8 saal se welder", "Ram-Prasad")).toBe("name");
    expect(reasonOf("Anil Souza, plumber hoon", "Anil D'Souza")).toBe("name");
    // Stored with the precomposed nukta letter, typed without the nukta.
    expect(
      reasonOf(
        "\u091C\u093E\u0915\u093F\u0930, \u0935\u0947\u0932\u094D\u0921\u0930",
        "\u095B\u093E\u0915\u093F\u0930 \u0916\u093E\u0928",
      ),
    ).toBe("name");
    expect(reasonOf("Saman ki loading, 5 saal", "S.Aman")).toBeNull();
  });

  it("a Devanagari-stored name is matched in Devanagari", () => {
    expect(reasonOf("मैं रमेश हूँ, वेल्डर", "रमेश यादव")).toBe("name");
  });

  it("self-introduction cues are refused with no stored name at all", () => {
    for (const raw of [
      "Mera naam Suresh hai, welder",
      "My name is Suresh, driver",
      "Myself Suresh, 5 saal ka experience",
      "Suresh naam hai, cook",
      "मेरा नाम सुरेश है",
    ]) {
      expect(reasonOf(raw, null)).toBe("name");
    }
  });

  it("word-anchored: a name token inside a longer word is not the name", () => {
    // "Ram" in "Rampur", "programme"; "Kumar" is not in "Kumaran" — the redactor's anchoring.
    expect(reasonOf("Rampur mein programme chalata hoon", "Ram Singh")).toBeNull();
    expect(reasonOf("Kumaran Textiles mein kaam kiya", "Kumar")).toBeNull();
  });

  it("tokens shorter than three characters are never matched — initials are letters, not names", () => {
    expect(reasonOf("R K welding works mein 5 saal", "R K Om")).toBeNull();
  });

  it('"myself" mid-sentence is prose, not an introduction', () => {
    expect(reasonOf("Excel maine myself seekha", null)).toBeNull();
  });

  it("identifiers still lead: a brief with a phone AND a name is refused for the phone", () => {
    expect(reasonOf("Ramesh, call 9876543210", NAME)).toBe("identifier");
  });

  it("the known cost: a name token that is also a word is refused for that worker", () => {
    // "das" is ten; a worker surnamed Das writes "10 saal" instead (module header).
    expect(reasonOf("das saal se welder hoon", "Mohan Das")).toBe("name");
    expect(reasonOf("das saal se welder hoon", NAME)).toBeNull();
  });

  it("the known gap: a Latin-stored name typed in Devanagari passes without a cue", () => {
    expect(reasonOf("मैं रमेश हूँ, वेल्डर", NAME)).toBeNull();
  });
});

describe("screenBrief — MONEY is refused at write time (owner ruling 2026-09-27)", () => {
  // The brief prints on the EMPLOYER copy, and the one figure that copy withholds is the worker's
  // asking price. Every shape below would put it back on the page in prose.
  it.each([
    // a currency sign, anywhere
    "₹15000 chahiye",
    "Kam se kam ₹ 18,000",
    "Dubai mein $800 milte the",
    // a currency word next to a number, either side
    "Rs 15000 per month",
    "rs.15000 chahiye",
    "INR 20000 expected",
    "15000 rupees chahiye",
    "15000 rupaye milne chahiye",
    "18000 rupay",
    "15000 रुपये चाहिए",
    "रु 15000 महीना",
    "15000 रु",
    // a number followed by a magnitude or the rupee dash
    "15k chahiye",
    "15 k se kam nahi",
    "15 hazar chahiye",
    "18 hazaar mile",
    "20 thousand expected",
    "3 lakh saal ka",
    "4 LPA",
    "15 हजार चाहिए",
    "15000/- per month",
    // a salary word, with or without a figure
    "Salary achhi honi chahiye",
    "tankhwah time pe chahiye",
    "Tankha badhiya ho",
    "pagar kam hai",
    "vetan ki baat baad mein",
    "CTC negotiable",
    "सैलरी अच्छी चाहिए",
    "वेतन समय पर",
    "पगार कम है",
    "तनख्वाह ठीक हो",
    // the other spellings of the rupee word (the review's probes)
    "15000 रुपए चाहिए",
    "१५००० रुपए महीना",
    "15000 रूपये",
    "15000 रुपया",
    "रू 15000",
    "15000 rupaya",
    "15000 rupiya",
    "15000 rupye",
    // a salary-sized figure beside a pay period or an ask
    "18000 mahina chahiye",
    "15000 per month",
    "15000/month",
    "15,000 pm",
    "मुझे 15000 महीना चाहिए",
    "15000 प्रति माह",
    "Welder hoon, 15000 chahiye",
    "20000 expected",
    "500 per day milta tha",
    "700 daily",
    // misspelled salary words, and pay synonyms beside a figure
    "sallary 15000",
    "salery achhi ho",
    "salry kam thi",
    "tankhwaah 15000",
    "18000 ka package",
    "wage 15000",
    "pay: 12000",
    "income 20000",
    "15000 की कमाई",
  ])("refuses %s as salary", (raw) => {
    expect(reasonOf(raw)).toBe("salary");
  });

  it.each([
    // The ordinary numbers of a work brief — years, spans, head-counts — are not money.
    "10 saal ka experience hai",
    "Maine 2015 se 2023 tak kaam kiya.",
    "5 log ki team sambhali",
    "3 shift mein machine chalayi",
    "12th pass, ITI electrician",
    "मैं 5 साल से वेल्डिंग का काम कर रहा हूँ।",
    // A currency word that is not next to a number, and a word that merely starts like one.
    "Working hours flexible",
    "5 hours roz practice",
    // A number written as a word is not a figure an employer can anchor on.
    "do hazar log ke event mein cook raha",
    // "k" as the chat form of "ke" before a postposition is prose, not a thousand.
    "2019 k baad se wiring ka kaam karta hoon",
    "Class 10 k baad ITI kiya, fitter hoon",
    "5 saal k experience",
    // Short durations and clock times beside a period word are not pay.
    "6 mahine ka course kiya",
    "3 month ka training",
    "8 hours daily machine chalata hoon",
    "Shift 5 pm tak",
    // Pay synonyms that are ordinary prose away from a figure; a tailor's stitch.
    "Tally package mein accounts",
    "Kurta mein tanka lagata hoon",
    // A bare figure with no cue at all cannot be told from a count.
    "1500 parts roz banata hoon",
  ])("passes %s", (raw) => {
    expect(reasonOf(raw)).toBeNull();
  });

  it("any-script digits count — a Devanagari figure beside a currency word is money", () => {
    expect(reasonOf("१५००० रुपये चाहिए")).toBe("salary");
    expect(looksLikeMoney("१५००० रुपये चाहिए")).toBe(true);
  });

  it("the precomposed and the decomposed nukta are both read (NFKC decomposes it)", () => {
    expect(looksLikeMoney("15 हज़ार")).toBe(true);
    expect(looksLikeMoney("15 हज़ार".normalize("NFKC"))).toBe(true);
    expect(looksLikeMoney("तनख़्वाह ठीक हो".normalize("NFKC"))).toBe(true);
  });

  it("sits after the routes and before the name: a handle is the route, a figure beats the name", () => {
    // The UPI handle is the more specific thing to retype.
    expect(reasonOf("UPI ramesh@okaxis, 15000 chahiye")).toBe("contact");
    // A figure beside the worker's own name is refused for the figure.
    expect(reasonOf("Ramesh ko 15k chahiye", "Ramesh Kumar")).toBe("salary");
  });

  it("a salary-sized figure beside an ask is money; the same figure with no cue is a count", () => {
    // "15000 chahiye" is an asking price; "1500 parts roz" is output. Recorded in ADR-0045 §6.
    expect(reasonOf("15000 chahiye, welder hoon")).toBe("salary");
    expect(reasonOf("1500 parts roz banata hoon")).toBeNull();
  });

  it("the predicate the résumé re-runs is the one the wall runs", () => {
    // `resume/resume-brief.ts` imports THIS function for its render-time re-check.
    expect(looksLikeMoney("Salary 15k")).toBe(true);
    expect(looksLikeMoney("10 saal ka experience hai")).toBe(false);
  });
});

describe("readStoredBrief — the one narrower the form and the résumé share", () => {
  it("reads an answered brief and a decline", () => {
    expect(readStoredBrief({ status: "answered", text: "Welder hoon" })).toEqual({
      status: "answered",
      text: "Welder hoon",
    });
    expect(readStoredBrief({ status: "declined" })).toEqual({ status: "declined" });
  });

  it("reads anything else as no brief — strict, and it never throws", () => {
    for (const value of [
      undefined,
      null,
      "Welder hoon",
      { status: "answered" },
      { status: "answered", text: "" },
      { status: "answered", text: "x", extra: 1 },
      { status: "declined", text: "x" },
      { kind: "other_answer", text: "x" },
      [],
    ]) {
      expect(readStoredBrief(value), JSON.stringify(value) ?? "undefined").toBeUndefined();
    }
  });
});
