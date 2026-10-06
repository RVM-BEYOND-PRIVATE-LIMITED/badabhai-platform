import { describe, expect, it } from "vitest";
import { checkPersonaTokens, personaCorpus } from "@badabhai/profiling-lexicon";
import { FREE_CHAT_REFUSAL_TOPICS } from "@badabhai/types";

import { CONSTANT_REPLIES } from "../reply-closure";
import { ttsTextFor } from "../question-tts-text";
import {
  FREE_CHAT_COPY,
  FREE_CHAT_COPY_ENTRIES,
  FREE_CHAT_LATER_KEY,
  FREE_CHAT_LATER_LABEL,
  FREE_CHAT_REFUSAL_LINES,
  FREE_CHAT_REPLIES,
  FREE_CHAT_RESUME_KEY,
  FREE_CHAT_RESUME_LABEL,
  FREE_CHAT_START_KEY,
  FREE_CHAT_START_LABEL,
} from "./free-chat.copy";

/**
 * The free chat's approved copy (ADR-0051 §5.1), held to persona v3.2 — the same scan
 * `companion-replies.test.ts` runs over the companion's lines, plus the ADR's own rules: the only
 * number in any line is the Tele-MANAS helpline, and every line has a Devanagari twin a voice can
 * read.
 */

const DEVANAGARI = /[ऀ-ॿ]/u;
// Pictographs and the emoji presentation selector — the persona ships no emoji.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|\u{FE0F}/u;
const words = (line: string): number => line.trim().split(/\s+/).filter(Boolean).length;
const persona = personaCorpus();

describe("free-chat copy is on-persona (persona v3.2)", () => {
  const shown: ReadonlyArray<readonly [string, string]> = [
    ...FREE_CHAT_COPY_ENTRIES.map(([name, line]) => [name, line.latin] as const),
    // The chips' labels are posted back as text, so they are copy too.
    ["chip", FREE_CHAT_START_LABEL],
    ["chip", FREE_CHAT_LATER_LABEL],
    ["chip", FREE_CHAT_RESUME_LABEL],
  ];

  it.each(shown)("%s — %j carries no banned token", (_name, text) => {
    expect(checkPersonaTokens(text)).toEqual([]);
  });

  it.each(shown)(
    "%s — %j has no exclamation, no emoji, at most one question mark",
    (_name, text) => {
      expect(text).not.toContain("!");
      expect(text).not.toMatch(EMOJI);
      expect((text.match(/\?/g) ?? []).length).toBeLessThanOrEqual(persona.maxQuestionMarks);
    },
  );

  it.each(shown)("%s — %j is under twenty words and in Latin script", (_name, text) => {
    expect(words(text)).toBeLessThanOrEqual(20);
    expect(text).not.toMatch(DEVANAGARI);
  });

  it.each(shown)(
    "%s — %j carries no number of four digits or more but the helpline",
    (name, text) => {
      const numbers = text.match(/\d{4,}/g) ?? [];
      expect(numbers).toEqual(name === "DISTRESS" ? ["14416"] : []);
    },
  );

  it("is name-free — no placeholder, so a pre-rendered clip is the same for every worker", () => {
    for (const [, line] of FREE_CHAT_COPY_ENTRIES) {
      expect(line.latin).not.toMatch(/\{\{|\}\}/);
      expect(line.dev).not.toMatch(/\{\{|\}\}/);
    }
  });
});

describe("every line has a Devanagari twin a voice can read", () => {
  it.each(FREE_CHAT_COPY_ENTRIES)(
    "%s — the twin is Devanagari, with no Latin word left in it",
    (_name, line) => {
      expect(line.dev).toMatch(DEVANAGARI);
      expect(line.dev).not.toMatch(/[A-Za-z]/);
    },
  );

  it("the helpline is the same number in both scripts", () => {
    expect(FREE_CHAT_COPY.DISTRESS.latin).toContain("14416");
    expect(FREE_CHAT_COPY.DISTRESS.dev).toContain("14416");
  });

  it("the sidecar serves each twin — and composes the twin of a deflection + a known question", () => {
    for (const [, line] of FREE_CHAT_COPY_ENTRIES) expect(ttsTextFor(line.latin)).toBe(line.dev);
    const question = "Shukriya. Aap kaun sa kaam karte hain, aur kitna tajurba hai?";
    expect(ttsTextFor(`${FREE_CHAT_COPY.LOCK_DEFLECT.latin} ${question}`)).toBe(
      `${FREE_CHAT_COPY.LOCK_DEFLECT.dev} ${ttsTextFor(question)}`,
    );
    expect(ttsTextFor(`${FREE_CHAT_COPY.LOCK_CLARIFY.latin} ${FREE_CHAT_COPY.OPENER.latin}`)).toBe(
      `${FREE_CHAT_COPY.LOCK_CLARIFY.dev} ${FREE_CHAT_COPY.OPENER.dev}`,
    );
    // Half Devanagari, half roman is worse than the roman line the client already speaks.
    expect(
      ttsTextFor(`${FREE_CHAT_COPY.LOCK_DEFLECT.latin} Kya aap chandrayaan udate hain?`),
    ).toBeUndefined();
  });
});

describe("the chips and the refusal map", () => {
  it("keys are digit-free slugs the option schema accepts, clear of the app-reserved keys", () => {
    for (const key of [FREE_CHAT_START_KEY, FREE_CHAT_LATER_KEY, FREE_CHAT_RESUME_KEY]) {
      expect(key).toMatch(/^[a-z_]+$/);
      expect(key).not.toMatch(/^(llm_|section_|companion_)/);
      expect([
        "companion_jobs_tab",
        "companion_applied",
        "resume_upload",
        "resume_chat_create",
        "kuch_aur",
      ]).not.toContain(key);
    }
  });

  it("maps EVERY refusal topic to a reviewed line — unsafe_other is the fallback", () => {
    for (const topic of FREE_CHAT_REFUSAL_TOPICS)
      expect(FREE_CHAT_REFUSAL_LINES[topic]).toBeDefined();
    expect(FREE_CHAT_REFUSAL_LINES.unsafe_other).toBe(FREE_CHAT_COPY.REPLY_FALLBACK);
    expect(FREE_CHAT_REFUSAL_LINES.distress).toBe(FREE_CHAT_COPY.DISTRESS);
  });

  it("every line is in the reply closure — the render manifest and the interpolation guard see it", () => {
    for (const line of FREE_CHAT_REPLIES) expect(CONSTANT_REPLIES).toContain(line);
  });
});
