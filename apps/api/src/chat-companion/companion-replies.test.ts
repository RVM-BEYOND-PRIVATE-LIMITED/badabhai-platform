/**
 * Every companion line held to persona v3.2 (ADR-0044) — the same scan `profiling/persona-copy.test.ts`
 * runs over the interview's own copy, plus the structural rules the persona states in prose.
 *
 * Rendered at BOUNDARY slot values, because a template can be clean and its rendering not: a
 * count of 1 takes a different sentence, and a count at the cap reads "{n} se zyada".
 */
import { describe, expect, it } from "vitest";
import { checkPersonaTokens, personaCorpus } from "@badabhai/profiling-lexicon";
import {
  ALL_COPY_PAIRS,
  MISSING_FIELD_LABELS,
  fillSlots,
  guaranteeLine,
  type CopyPair,
} from "./companion-replies";
import {
  COMPANION_APPLIED_LABEL,
  COMPANION_JOBS_TAB_LABEL,
  COMPANION_NEW_JOBS_LABEL,
  COMPANION_RESUME_LABEL,
} from "./companion-keys";

const DEVANAGARI = /[ऀ-ॿ]/u;
// Pictographs and the emoji presentation selector — the persona ships no emoji.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|\u{FE0F}/u;
const SLOT_SAMPLES: Readonly<Record<string, readonly (string | number)[]>> = {
  n: [0, 1, 2, 20],
  d: [1, 7, 30],
  facts: ["VMC Operator, 5 saal tajurba, Fanuc, Siemens, Pune"],
  field: Object.values(MISSING_FIELD_LABELS).map((l) => l.latin),
};

function slotsOf(template: string): string[] {
  return [...template.matchAll(/\{([a-z]+)\}/g)].map((m) => m[1]!);
}

/** Every rendering of a template across the sample values of each slot it names. */
function renderings(template: string): string[] {
  let out = [template];
  for (const slot of new Set(slotsOf(template))) {
    const values = SLOT_SAMPLES[slot];
    if (!values) throw new Error(`no sample values for slot {${slot}}`);
    out = out.flatMap((t) => values.map((v) => t.split(`{${slot}}`).join(String(v))));
  }
  return out;
}

const words = (line: string): number => line.trim().split(/\s+/).filter(Boolean).length;
const persona = personaCorpus();

describe("companion copy is on-persona (persona v3.2)", () => {
  const shown: ReadonlyArray<readonly [string, string]> = [
    ...ALL_COPY_PAIRS.flatMap(([name, pair]) => renderings(pair.latin).map((t) => [name, t] as const)),
    ["guaranteeLine", guaranteeLine()],
    ...[COMPANION_NEW_JOBS_LABEL, COMPANION_JOBS_TAB_LABEL, COMPANION_APPLIED_LABEL, COMPANION_RESUME_LABEL].map(
      (l) => ["chip", l] as const,
    ),
  ];

  it.each(shown)("%s — %j carries no banned token", (_name, text) => {
    expect(checkPersonaTokens(text)).toEqual([]);
  });

  it.each(shown)("%s — %j has no exclamation, no emoji, at most one question mark", (_name, text) => {
    expect(text).not.toContain("!");
    expect(text).not.toMatch(EMOJI);
    expect((text.match(/\?/g) ?? []).length).toBeLessThanOrEqual(persona.maxQuestionMarks);
  });

  it.each(shown)("%s — %j is under twenty words and in Latin script", (_name, text) => {
    expect(words(text)).toBeLessThanOrEqual(20);
    expect(text).not.toMatch(DEVANAGARI);
  });

  it.each(shown)("%s — %j names no counterparty and makes no promise", (_name, text) => {
    // The sanctioned guarantee line is the one place "companies" may appear.
    const scanned = text === guaranteeLine() ? "" : text.toLowerCase();
    expect(scanned).not.toMatch(/\b(employer|company|companies|payer)\b/);
    expect(scanned).not.toMatch(/\b(batayenge|pakka|guarantee|jaldi|zaroor)\b/);
    // Never a four-digit number: counts are capped, and pay/phone never ride a line.
    expect(text).not.toMatch(/\d{4,}/);
  });

  it("the guarantee reply IS the persona's line, verbatim", () => {
    expect(guaranteeLine()).toBe(persona.guaranteeLine);
  });
});

describe("every line has a Devanagari twin a voice can read", () => {
  it.each(ALL_COPY_PAIRS)("%s — the twin is Devanagari and carries the same slots", (name, pair: CopyPair) => {
    expect(pair.dev).toMatch(DEVANAGARI);
    // Slot NAMES are Latin by construction; what a voice reads around them must not be.
    expect(pair.dev.replace(/\{[a-z]+\}/g, "")).not.toMatch(/[A-Za-z]/);
    expect(pair.dev).not.toContain("{{");
    if (name === "GLANCE") {
      // Its slot is free labels (a role title, a city): the twin names none of them, so a
      // Devanagari voice is never handed Latin words.
      expect(slotsOf(pair.dev)).toEqual([]);
    } else {
      expect(slotsOf(pair.dev).sort()).toEqual(slotsOf(pair.latin).sort());
    }
  });

  it.each(Object.entries(MISSING_FIELD_LABELS))("the %s label has a Devanagari twin", (_field, label) => {
    expect(label.dev).toMatch(DEVANAGARI);
    expect(label.dev).not.toMatch(/[A-Za-z]/);
    expect(label.latin).not.toMatch(DEVANAGARI);
  });

  it("an unfilled slot throws instead of reaching a worker as '{n}'", () => {
    expect(() => fillSlots("Aapne ab tak {n} jobs par apply kiya hai.")).toThrow(/\{n\}/);
  });
});
