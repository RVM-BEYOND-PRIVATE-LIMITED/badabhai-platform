/**
 * The voice-hold rule (#3018): held only when the pinned pack version is not voice ready, the turn
 * serves a pack question, and the line has no Devanagari twin. The prompts are EDM's real v1 (has a
 * twin) and v2 (CEO pack v2 sheet T17, no twin) lines.
 */
import { describe, expect, it } from "vitest";

import { ttsTextFor } from "./question-tts-text";
import { VOICE_FALLBACK_HINT, voiceHeld } from "./voice-hold";

const V2_PROMPT = "Aap kaunsi EDM machine chalate hain?";
const V1_PROMPT = "Kaunsi EDM machine chalate hain?";
const HELD_PIN = { packId: "qp_edm_wirecut", packVersion: 2 };

describe("voiceHeld", () => {
  it("is pinned to real prompts: v1 has a twin, v2 does not", () => {
    expect(ttsTextFor(V1_PROMPT)).toBeDefined();
    expect(ttsTextFor(V2_PROMPT)).toBeUndefined();
  });

  it("holds a twin-less question on a not-voice-ready pack version", () => {
    expect(voiceHeld(HELD_PIN, "edm_machine", V2_PROMPT)).toBe(true);
    expect(
      voiceHeld(
        { packId: "qp_cmm", packVersion: 1 },
        "cmm_level",
        "CMM room me aap kya karte hain?",
      ),
    ).toBe(true);
  });

  it("never holds a voice-ready pack, a line with a twin, a non-question, or an unpinned session", () => {
    expect(voiceHeld({ packId: "qp_edm_wirecut", packVersion: 1 }, "edm_machine", V2_PROMPT)).toBe(
      false,
    );
    expect(
      voiceHeld({ packId: "qp_cnc_turning", packVersion: 6 }, "turning_machine", V2_PROMPT),
    ).toBe(false);
    expect(voiceHeld(HELD_PIN, "edm_machine", V1_PROMPT)).toBe(false);
    expect(voiceHeld(HELD_PIN, null, V2_PROMPT)).toBe(false);
    expect(voiceHeld(null, "edm_machine", V2_PROMPT)).toBe(false);
    expect(voiceHeld({ packId: null, packVersion: null }, "edm_machine", V2_PROMPT)).toBe(false);
  });

  it("the fixed line is Hinglish only — shown, never read aloud", () => {
    expect(VOICE_FALLBACK_HINT).not.toMatch(/\p{Script=Devanagari}/u);
    expect(VOICE_FALLBACK_HINT.trim()).toBe(VOICE_FALLBACK_HINT);
  });
});
