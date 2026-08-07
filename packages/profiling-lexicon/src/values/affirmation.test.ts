import { describe, expect, it } from "vitest";

import { classifyUtterance } from "../predicates/index.js";
import { parseAffirmation } from "./affirmation.js";

/**
 * The yes/no reader for the 236 boolean pack items that carry no chips.
 *
 * The cases that matter are not "does haan mean yes". They are the three where a naive
 * keyword scan gets it BACKWARDS or gives an answer where there is none:
 *
 *   - a negated yes ("haan nahi") must be `false`, not `true`
 *   - a bare negator ("nahi") must be `false`, not `null` — `applyNegation` reports the spans it
 *     BLANKED, and a message that is only the negator has nothing after it to blank
 *   - a hedge ("kabhi kabhi") must be `null`, not a guessed `false`
 */

const yes = (text: string) => parseAffirmation(text)?.value;

describe("parseAffirmation", () => {
  it.each([
    "haan",
    "Haan",
    "haan ji",
    "ji haan",
    "hanji",
    "ji",
    "Ji sir",
    "bilkul",
    "zaroor",
    "sahi hai",
    "theek hai",
    "yes",
    "haan bilkul karta hoon",
    "हाँ",
    "जी हाँ",
    "बिल्कुल",
  ])("reads an explicit yes: %s", (text) => {
    expect(yes(text)).toBe(true);
  });

  it.each([
    "nahi",
    "nahin",
    "nhi",
    "nahi karta",
    "bilkul nahi",
    "kabhi nahi kiya",
    "no",
    "नहीं",
    "मैं नहीं करता",
  ])("reads an explicit no: %s", (text) => {
    expect(yes(text)).toBe(false);
  });

  it.each(["karta hoon", "kar leta hoon", "aata hai", "jaanta hoon", "seekha hai", "करता हूँ"])(
    "reads a first-person verb claim as yes: %s",
    (text) => {
      expect(yes(text)).toBe(true);
    },
  );

  it.each(["nahi karta hoon", "mujhe nahi aata", "kabhi nahi kiya hai"])(
    "a negated verb claim is a NO, not a yes: %s",
    (text) => {
      expect(yes(text)).toBe(false);
    },
  );

  it("a negated yes is a NO, and says so", () => {
    // The backwards case. A keyword scan sees "haan" and returns true; the worker said the
    // opposite, and this value goes into a column the matcher filters on.
    const result = parseAffirmation("haan nahi, main nahi karta");
    expect(result?.value).toBe(false);
  });

  it("keeps a yes when the negator belongs to an EARLIER clause", () => {
    // "kaam nahi mil raha" is about work, not about the question. Clause clamping is why the
    // negation engine is reused rather than reimplemented as a look-back over the whole string.
    expect(yes("kaam nahi mil raha, gas charging karta hoon")).toBe(true);
  });

  it.each(["kabhi kabhi", "thoda thoda", "shayad", "5 saal", ""])(
    "returns null rather than guessing on a non-answer: %s",
    (text) => {
      expect(parseAffirmation(text)).toBeNull();
    },
  );

  it("leaves `pata nahi` to the don't-know classifier, which diverts it before capture", () => {
    // THE CONTRACT BOUNDARY, asserted rather than assumed. In isolation this reader would call
    // "pata nahi chalta kitna" a `false` — there is a negator and nothing else. That is only safe
    // because `classifyUtterance` sees it first and routes it to `dont_know`, which the
    // orchestrator records as DECLINED, not as "no". If that ever stops being true, this test goes
    // red before a worker's "I don't know" starts being stored as an answer.
    expect(classifyUtterance("pata nahi chalta kitna").cls).toBe("dont_know");
    expect(classifyUtterance("mujhe nahi pata").cls).toBe("dont_know");
  });

  it("does not fire on the copula `hai`, which appears in almost every Hindi sentence", () => {
    // `hai` is "is". If it were a cue, every sentence in the corpus would read as a yes.
    expect(parseAffirmation("mera naam Ramesh hai")).toBeNull();
  });

  it("reports a span that points at the cue it actually read", () => {
    // The span feeds the parse call's provenance gate, so it has to be the evidence, not 0..0.
    const result = parseAffirmation("main bilkul karta hoon");
    expect(result).not.toBeNull();
    expect("main bilkul karta hoon".slice(result!.span.start, result!.span.end)).toBe("bilkul");
  });

  it("prefers the two-word Devanagari cue over the bare honorific", () => {
    // Alternation order is load-bearing: bare `जी` placed first would win on `जी हाँ` and report a
    // one-character span where a two-word cue stands.
    const result = parseAffirmation("जी हाँ");
    expect(result?.value).toBe(true);
    expect("जी हाँ".slice(result!.span.start, result!.span.end)).toBe("जी हाँ");
  });

  it("flags negationVetoed only when an affirmative cue actually lost", () => {
    expect(parseAffirmation("nahi haan")?.negationVetoed).toBe(true);
    expect(parseAffirmation("haan")?.negationVetoed).toBe(false);
    expect(parseAffirmation("nahi")?.negationVetoed).toBe(false);
  });
});
