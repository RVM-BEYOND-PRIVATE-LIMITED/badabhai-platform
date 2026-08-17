import { describe, it, expect } from "vitest";
import { CONSTANT_REPLIES, normalizeReplyText } from "./reply-closure";
import {
  DEVANAGARI_RE,
  TTS_CONSTANT_SOURCES,
  TTS_TEXT_ENTRIES,
  ttsTextFor,
} from "./question-tts-text";

/**
 * The guard that keeps the Devanagari sidecar honest (#896).
 *
 * The keys in `question-tts-text.ts` are LITERAL roman strings rather than imports of the
 * constants, precisely so that editing a constant orphans its key instead of silently re-pointing
 * it at Devanagari that no longer says the same thing. That trade only pays if something notices
 * the orphan — this file is that something.
 */
describe("question-tts-text — coverage of the reply closure's constants", () => {
  it("covers EVERY CONSTANT_REPLIES entry — a ninth constant without its twin fails here", () => {
    const missing = CONSTANT_REPLIES.filter((reply) => ttsTextFor(reply) === undefined);
    expect(
      missing,
      `these engine constants have no Devanagari twin in question-tts-text.ts:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("enumerates the SAME constants the closure does — neither side drifts alone", () => {
    expect([...TTS_CONSTANT_SOURCES].sort()).toEqual([...CONSTANT_REPLIES].sort());
  });

  it("has NO orphan keys — every key still matches a live engine string", () => {
    // A pack-derived key is legitimate and unresolvable from here (the packs live in Postgres),
    // so only constant-shaped keys are checked: today the table is constants-only, and this
    // assertion is what will need relaxing — deliberately, in the PR that adds the corpus.
    const live = new Set(CONSTANT_REPLIES.map(normalizeReplyText));
    const orphans = TTS_TEXT_ENTRIES.map(([roman]) => roman).filter(
      (roman) => !live.has(normalizeReplyText(roman)),
    );
    expect(
      orphans,
      `these keys match no engine constant — a constant was edited without re-authoring its Devanagari:\n  ${orphans.join("\n  ")}`,
    ).toEqual([]);
  });
});

describe("question-tts-text — the authored strings", () => {
  it("is actually Devanagari on the value side, and never on the key side", () => {
    for (const [roman, devanagari] of TTS_TEXT_ENTRIES) {
      expect(DEVANAGARI_RE.test(devanagari), `not Devanagari: ${devanagari}`).toBe(true);
      expect(DEVANAGARI_RE.test(roman), `key must be the ROMAN text: ${roman}`).toBe(false);
    }
  });

  it("keeps the placeholder count identical, so interpolation cannot diverge", () => {
    // `renderPackText` runs over BOTH strings. A twin that dropped `{{worker_name}}` would be
    // spoken without the name the screen shows; one that gained a second copy would say it twice.
    const count = (s: string) => (s.match(/\{\{worker_name\}\}/g) ?? []).length;
    for (const [roman, devanagari] of TTS_TEXT_ENTRIES) {
      expect(count(devanagari), `placeholder mismatch for: ${roman}`).toBe(count(roman));
    }
  });

  it("carries no romanized leftovers in the spoken string", () => {
    // A stray Latin word is the one defect that survives review by eye: it reads fine in the diff
    // and is the exact thing the voice cannot pronounce. Acronyms a Hindi voice does say as
    // letters (MIG, TIG) are allowed; ordinary lowercase Latin words are not.
    for (const [roman, devanagari] of TTS_TEXT_ENTRIES) {
      const latinWords = devanagari.match(/[a-z]{2,}/g) ?? [];
      expect(latinWords, `untransliterated words in the twin of: ${roman}`).toEqual([]);
    }
  });
});

describe("ttsTextFor", () => {
  const OPENER = "Namaste. Aap kaun sa kaam karte hain, kahan rehte hain, aur kitna tajurba hai?";

  it("resolves a known reply to its Devanagari", () => {
    expect(ttsTextFor(OPENER)).toBe(
      "नमस्ते। आप कौन सा काम करते हैं, कहाँ रहते हैं, और कितना तजुर्बा है?",
    );
  });

  it("tolerates the whitespace the engine can add, since the closure hashes under the same collapse", () => {
    expect(ttsTextFor(`  ${OPENER.replace(". ", ".\n  ")}  `)).toBe(ttsTextFor(OPENER));
  });

  it("returns undefined for an unauthored reply — the client then speaks the roman text", () => {
    expect(ttsTextFor("Aap kaunsi welding karte hain?")).toBeUndefined();
  });

  it("returns undefined for empty, null and undefined rather than throwing", () => {
    expect(ttsTextFor("")).toBeUndefined();
    expect(ttsTextFor(null)).toBeUndefined();
    expect(ttsTextFor(undefined)).toBeUndefined();
  });

  it("does NOT match on a prefix or a superstring — a near miss must stay a miss", () => {
    expect(ttsTextFor("Namaste.")).toBeUndefined();
    expect(ttsTextFor(`${OPENER} Aur kuch?`)).toBeUndefined();
  });
});
