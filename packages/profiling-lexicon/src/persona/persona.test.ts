/**
 * The product's voice, and the scan that protects it.
 *
 * These lists are the difference between an interview that sounds like a person and one that
 * sounds like a chatbot performing warmth. They were enforced per-turn in Python against a
 * model's output; now they are a build-time gate over authored text. The tests that matter
 * most are the two narrow ones — the brand name and the honest refusal both CONTAIN banned
 * tokens, and a guard that rejects the two phrases it exists to protect is a guard someone
 * switches off.
 */
import { describe, expect, it } from "vitest";

import { checkPersonaTokens, personaCorpus } from "./index.js";

describe("personaCorpus", () => {
  it("carries every closed set persona.py owned", () => {
    const c = personaCorpus();
    expect(c.acknowledgements.length).toBeGreaterThan(0);
    expect(c.appreciations.length).toBeGreaterThan(0);
    expect(c.bannedVocatives).toContain("bhai");
    expect(c.bannedInformal).toContain("tum");
    expect(c.bannedGush).toContain("zabardast");
    expect(c.bannedPromise).toContain("interview");
    expect(c.bannedDeictics).toContain("aur usme");
  });

  it("keeps the appreciation budget, not just the words", () => {
    // Praise that arrives every turn stops meaning anything. The budget IS the rule; the
    // word list without it is decoration.
    const c = personaCorpus();
    expect(c.maxAppreciationsPerConversation).toBe(2);
    expect(c.minTurnBeforeAppreciation).toBe(3);
  });

  it("keeps the honest refusal verbatim", () => {
    // A commitment, not phrasing. Reworded "nicer" it becomes the promise the platform
    // cannot keep.
    expect(personaCorpus().guaranteeLine).toContain("Guarantee nahi de sakta");
  });
});

describe("checkPersonaTokens", () => {
  it("passes clean, on-persona copy", () => {
    expect(checkPersonaTokens("Aap kaun sa kaam karte hain")).toEqual([]);
  });

  it("catches a vocative aimed at the worker", () => {
    expect(checkPersonaTokens("Bhai aap kya kaam karte hain")).toContainEqual(
      expect.stringContaining("vocative"),
    );
  });

  it("does NOT flag the product's own name", () => {
    // "Bada Bhai" contains a banned vocative. A guard that rejects the brand is a guard
    // nobody keeps switched on.
    expect(checkPersonaTokens("Main Bada Bhai hoon")).toEqual([]);
  });

  it("does NOT flag the sanctioned refusal", () => {
    // The honest line contains "guarantee", which is banned as a PROMISE. Same reasoning.
    expect(checkPersonaTokens(personaCorpus().guaranteeLine)).toEqual([]);
  });

  it("catches informal address", () => {
    expect(checkPersonaTokens("Tum kya karte ho")).toContainEqual(
      expect.stringContaining("informal"),
    );
  });

  it("matches WHOLE WORDS only — 'tu' must not fire inside 'status'", () => {
    // A guard that rejects the word "status" is one someone disables, and then none of the
    // rules are enforced.
    expect(checkPersonaTokens("Aapka status kya hai")).toEqual([]);
    expect(checkPersonaTokens("Tube light banate hain")).toEqual([]);
  });

  it("catches gush, in both scripts' worth of spelling variants", () => {
    for (const t of ["Zabardast kaam", "Shabash aapne", "Perfect answer"]) {
      expect(checkPersonaTokens(t), t).toContainEqual(expect.stringContaining("gush"));
    }
  });

  it("catches the word 'interview' — this is profiling, not an interview", () => {
    // Calling it an interview sets an expectation the platform cannot keep.
    expect(checkPersonaTokens("Aapka interview kab hai")).toContainEqual(
      expect.stringContaining("promise"),
    );
  });

  it("catches a deictic, because every turn must stand alone", () => {
    // A worker on 2G may see one message with no history. "aur usme?" is unreadable alone.
    expect(checkPersonaTokens("Aur usme kitne saal")).toContainEqual(
      expect.stringContaining("deictic"),
    );
  });

  it("survives punctuation — a token at a sentence end is still a whole word", () => {
    expect(checkPersonaTokens("Kaam batayiye, bhai.")).toContainEqual(
      expect.stringContaining("vocative"),
    );
  });

  it("names the RULE, not just the word", () => {
    // "contains a banned word" sends a reviewer hunting; "banned gush: perfect" tells them
    // what to change and why the rule exists.
    const [first] = checkPersonaTokens("Perfect");
    expect(first).toMatch(/^banned [a-z ]+: /);
  });

  it("reports EVERY violation, never just the first", () => {
    expect(checkPersonaTokens("Bhai tum zabardast ho").length).toBeGreaterThanOrEqual(3);
  });

  it("leaves Devanagari alone", () => {
    // None of the banned tokens are in that script, and mangling it here would silently
    // change what the scan sees for a Hindi prompt.
    expect(checkPersonaTokens("आप क्या काम करते हैं")).toEqual([]);
  });
});
