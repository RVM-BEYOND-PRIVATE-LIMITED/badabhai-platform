import { describe, expect, it } from "vitest";

import {
  isEnumerationOfPrinted,
  normalizeForMatch,
  OWN_WORDS_MAX,
  OWN_WORDS_MAX_CHARS,
  OWN_WORDS_MIN_CHARS,
  selectOwnWords,
  splitIntoPhrases,
} from "./resume-own-words";

/**
 * THE FIXTURE IS THE R7 PERSONA RUN, VERBATIM — persona 2's actual turns and the actual
 * sentences `gemini-2.5-flash` returned for him. Not invented text: the whole value of this
 * block is what it does against real model output, and a hand-written "model said X" fixture
 * would only prove the function agrees with whoever wrote it.
 */
const P2_TURNS = [
  "CNC lathe chalata hoon sir. Do saal ho gaye.",
  "Shakti Precision Components me, Rajkot me. July 2024 se hoon, wahi meri pehli naukri hai.",
  "CNC lathe hai, Fanuc control. Ek hi machine par rehta hoon zyada tar.",
  "Programme load karke part banata hoon. Facing, turning, drilling, grooving. Pump ka housing aur shaft banate hain hum, MS aur EN8 me.",
  "Nahi sir, programme setter banata hai. Main sirf chalata hoon. Offset thoda bahut dekh leta hoon jab supervisor bolte hain, par khud se setting nahi karta.",
  "Vernier aur micrometer. Plug gauge bhi rakhte hain bore ke liye. Drawing dekh leta hoon, simple wali.",
];

/** What the model actually returned in `experiences[0].work_done` for persona 2. */
const P2_WORK_DONE =
  "CNC lathe chalata hoon. Programme load karke part banata hoon. Facing, turning, drilling, " +
  "grooving. Pump ka housing aur shaft banate hain hum, MS aur EN8 me. Offset thoda bahut dekh " +
  "leta hoon. Vernier aur micrometer, plug gauge use karta hoon. Drawing dekh leta hoon.";

describe("normalizeForMatch", () => {
  it("folds case, collapses whitespace and strips edge punctuation", () => {
    expect(normalizeForMatch("  CNC  lathe chalata hoon.  ")).toBe("cnc lathe chalata hoon");
    expect(normalizeForMatch("“Drawing dekh leta hoon,”")).toBe("drawing dekh leta hoon");
  });

  it("does NOT strip punctuation from the middle", () => {
    // Inner commas are what `isEnumerationOfPrinted` splits on; eating them here would make
    // every enumeration look like one opaque phrase and the de-dupe would stop working.
    expect(normalizeForMatch("Facing, turning, drilling")).toBe("facing, turning, drilling");
  });
});

describe("splitIntoPhrases", () => {
  it("splits on sentence terminators including the Devanagari danda", () => {
    expect(splitIntoPhrases("Ek. Do! Teen? Chaar; Paanch।")).toEqual([
      "Ek",
      "Do",
      "Teen",
      "Chaar",
      "Paanch",
    ]);
  });

  it("NEVER splits on a comma", () => {
    // "Facing, turning, drilling, grooving" is one answer. Four fragments would each fall under
    // the length floor and vanish — the effect would be to delete his most concrete sentence.
    expect(splitIntoPhrases("Facing, turning, drilling, grooving")).toEqual([
      "Facing, turning, drilling, grooving",
    ]);
  });
});

describe("isEnumerationOfPrinted", () => {
  const printed = new Set(["facing", "turning", "drilling", "grooving", "cnc lathe operation"]);

  it("is true when EVERY segment is already a printed chip", () => {
    expect(isEnumerationOfPrinted("Facing, turning, drilling, grooving", printed)).toBe(true);
  });

  it("is false as soon as one segment is not — a sentence with a verb always survives", () => {
    // The failure this rules out: a containment test would kill "CNC lathe chalata hoon" because
    // a printed chip appears inside it, i.e. it would delete every sentence that names the trade.
    expect(isEnumerationOfPrinted("CNC lathe chalata hoon", printed)).toBe(false);
    expect(isEnumerationOfPrinted("Facing, turning, aur thoda boring", printed)).toBe(false);
  });
});

describe("selectOwnWords — the model proposes, the transcript disposes", () => {
  it("keeps the sentences persona 2 actually said", () => {
    const { phrases } = selectOwnWords({
      candidates: [P2_WORK_DONE],
      workerSaid: P2_TURNS,
      alreadyPrinted: [],
      max: 10,
    });
    expect(phrases).toContain("CNC lathe chalata hoon");
    expect(phrases).toContain("Programme load karke part banata hoon");
    expect(phrases).toContain("Pump ka housing aur shaft banate hain hum, MS aur EN8 me");
  });

  it("VETOES the one sentence the model composed rather than quoted", () => {
    // THE FINDING THIS FILE EXISTS FOR. The worker said "Vernier aur micrometer." and, separately,
    // "Plug gauge bhi rakhte hain bore ke liye." The model fused them into a single sentence with
    // a verb he never used. It reads perfectly and it is not his.
    const { phrases, notVerbatim } = selectOwnWords({
      candidates: [P2_WORK_DONE],
      workerSaid: P2_TURNS,
      alreadyPrinted: [],
      max: 10,
    });
    expect(phrases).not.toContain("Vernier aur micrometer, plug gauge use karta hoon");
    expect(notVerbatim).toContain("Vernier aur micrometer, plug gauge use karta hoon");
  });

  it("prints NOTHING when the transcript is unavailable", () => {
    // The degrade the render processor takes when the transcript read throws. Absence of evidence
    // is not evidence: with no turns to check against, no phrase can be vouched for, so the block
    // collapses rather than trusting the model's prose.
    const { phrases } = selectOwnWords({
      candidates: [P2_WORK_DONE],
      workerSaid: [],
      alreadyPrinted: [],
    });
    expect(phrases).toEqual([]);
  });

  it("drops an enumeration the chips already print", () => {
    const { phrases } = selectOwnWords({
      candidates: [P2_WORK_DONE],
      workerSaid: P2_TURNS,
      alreadyPrinted: ["Facing", "turning", "drilling", "grooving"],
      max: 10,
    });
    expect(phrases).not.toContain("Facing, turning, drilling, grooving");
    // …and the sentence beside it, which shares three of those words, is untouched.
    expect(phrases).toContain("Programme load karke part banata hoon");
  });

  it("holds the length window at both ends", () => {
    const short = "Haan sir";
    const long = "x".repeat(OWN_WORDS_MAX_CHARS + 1);
    expect(short.length).toBeLessThan(OWN_WORDS_MIN_CHARS);
    const { phrases } = selectOwnWords({
      candidates: [`${short}. ${long}.`],
      workerSaid: [short, long],
      alreadyPrinted: [],
      max: 10,
    });
    expect(phrases).toEqual([]);
  });

  it("caps the block and preserves the order the worker said things in", () => {
    const { phrases } = selectOwnWords({
      candidates: [P2_WORK_DONE],
      workerSaid: P2_TURNS,
      alreadyPrinted: [],
    });
    expect(phrases.length).toBeLessThanOrEqual(OWN_WORDS_MAX);
    expect(phrases[0]).toBe("CNC lathe chalata hoon");
  });

  it("screens a phrase that carries a contact detail even when he said it", () => {
    // `looksLikePii` is a backstop rather than the guarantee — but a worker who reads his phone
    // number aloud mid-interview must not get it quoted back on the sheet twice.
    const said = "Mera number 9876543210 hai sir, kabhi bhi call kar lena";
    const { phrases } = selectOwnWords({
      candidates: [said],
      workerSaid: [said],
      alreadyPrinted: [],
    });
    expect(phrases).toEqual([]);
  });

  it("de-duplicates a sentence the model repeated", () => {
    const { phrases } = selectOwnWords({
      candidates: ["CNC lathe chalata hoon.", "CNC lathe chalata hoon."],
      workerSaid: P2_TURNS,
      alreadyPrinted: [],
      max: 10,
    });
    expect(phrases).toEqual(["CNC lathe chalata hoon"]);
  });
});
