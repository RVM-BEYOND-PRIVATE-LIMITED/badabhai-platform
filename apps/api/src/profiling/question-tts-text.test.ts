import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { CONSTANT_REPLIES, normalizeReplyText } from "./reply-closure";
import {
  DEVANAGARI_RE,
  TTS_CONSTANT_SOURCES,
  TTS_TEXT_ENTRIES,
  ttsTextFor,
} from "./question-tts-text";

/**
 * The committed render manifest — every string the interview can say, content-addressed. Read
 * rather than rebuilt, because it is the same artifact the TTS render and its Python mirror are
 * keyed by, and a coverage claim measured against anything else would be measuring the wrong set.
 */
const CLOSURE = JSON.parse(
  readFileSync(
    join(__dirname, "../../../../packages/db/data/question-packs/reply-closure.json"),
    "utf8",
  ),
) as { clips: { id: string; text: string; producer: string }[] };

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

  it("has NO orphan keys — every key still matches a string the engine can serve", () => {
    // NOW CHECKED AGAINST THE WHOLE CLOSURE, not just the constants. `reply-closure.json` is the
    // committed manifest of every string the interview can say, so it is the exact authority for
    // "is this key still real". An orphan means a pack prompt or why-text was edited and its
    // Devanagari was not re-authored with it — the drift this file's literal keys exist to expose.
    const live = new Set(CLOSURE.clips.map((c) => normalizeReplyText(c.text)));
    const orphans = TTS_TEXT_ENTRIES.map(([roman]) => roman).filter(
      (roman) => !live.has(normalizeReplyText(roman)),
    );
    expect(
      orphans,
      `these keys match nothing in reply-closure.json — the roman text was edited without re-authoring its Devanagari:\n  ${orphans.join("\n  ")}`,
    ).toEqual([]);
  });
});

/**
 * COVERAGE, asserted as a floor rather than a percentage.
 *
 * The closure is the whole worker-facing vocabulary. A clip with no twin is a question some worker
 * hears mispronounced, so the interesting number is not "how much is covered" but "which ones are
 * not" — hence the failure message lists them.
 */
describe("question-tts-text — coverage of the reply closure", () => {
  it("covers EVERY clip: constants, prompts, retries, why-texts and composed clarifies", () => {
    const missing = CLOSURE.clips
      .filter((c) => ttsTextFor(c.text) === undefined)
      .map((c) => `${c.producer}: ${c.text}`);
    expect(
      missing,
      `${missing.length} of ${CLOSURE.clips.length} clips have no Devanagari twin:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("COMPOSES the clarify twins rather than authoring them", () => {
    // The 152 clarify clips are `why + " " + question`, so they must resolve WITHOUT appearing in
    // the authored table. If one ever needs a hand-written entry, the join rule has changed and
    // `composeClarify` is what should be fixed.
    const authored = new Set(TTS_TEXT_ENTRIES.map(([roman]) => normalizeReplyText(roman)));
    const clarifies = CLOSURE.clips.filter((c) => c.producer === "clarify");
    expect(clarifies.length).toBeGreaterThan(0);
    for (const clip of clarifies) {
      expect(authored.has(normalizeReplyText(clip.text)), `authored by hand: ${clip.text}`).toBe(
        false,
      );
      expect(ttsTextFor(clip.text), `not composed: ${clip.text}`).toBeDefined();
    }
  });

  it("composes a clarify twin as why + ' ' + question, in that order", () => {
    const why = "Har welding alag hoti hai, isse sahi naukri milti hai.";
    const question = "Aap kaunsi welding karte hain?";
    expect(ttsTextFor(`${why} ${question}`)).toBe(
      `${ttsTextFor(why)} ${ttsTextFor(question)}`,
    );
  });

  it("does NOT compose when only one half is authored", () => {
    // Half Devanagari and half roman is worse than the romanized line the client already speaks.
    const why = "Har welding alag hoti hai, isse sahi naukri milti hai.";
    expect(ttsTextFor(`${why} Kya aap chandrayaan udate hain?`)).toBeUndefined();
    expect(ttsTextFor("Yeh why text kisi pack me nahi hai. Aap kaunsi welding karte hain?"))
      .toBeUndefined();
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
    // DELIBERATELY not a real pack question. This case used a genuine prompt until the corpus
    // landed and authored it, which is the trap: the closure is now covered end to end, so the
    // only honest way to exercise a miss is a string no pack can ever contain.
    expect(ttsTextFor("Kya aap chandrayaan udate hain?")).toBeUndefined();
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
