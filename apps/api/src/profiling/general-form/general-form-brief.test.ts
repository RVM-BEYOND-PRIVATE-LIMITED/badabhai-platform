import { describe, expect, it } from "vitest";

import { GENERAL_FORM_BRIEF_MAX_CHARS } from "@badabhai/types";

import {
  BRIEF_RAW_MAX_UNITS,
  BRIEF_REFUSAL_REASONS,
  briefLength,
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
