/**
 * The voice-ready table (#3018) against the trade catalogue: one row per non-live form, a new
 * form held entirely, a deepened form's live version 1 kept and its compiled version 2 held.
 */
import { describe, expect, it } from "vitest";

import { TRADE_CATALOGUE } from "./trade-catalogue";
import { isPackVersionVoiceReady, VOICE_READY_THROUGH_VERSION } from "./voice-ready";

describe("VOICE_READY_THROUGH_VERSION", () => {
  it("has exactly one row per non-live catalogue form, and none for a live trade", () => {
    const nonLive = TRADE_CATALOGUE.filter((e) => e.status !== "live").map((e) => e.packId);
    expect(nonLive).toHaveLength(44);
    expect(Object.keys(VOICE_READY_THROUGH_VERSION).sort()).toEqual([...nonLive].sort());
    for (const e of TRADE_CATALOGUE.filter((t) => t.status === "live")) {
      expect(VOICE_READY_THROUGH_VERSION[e.packId], e.code).toBeUndefined();
    }
  });

  it("holds every new form entirely, and keeps a deepened form's live version 1", () => {
    for (const e of TRADE_CATALOGUE.filter((t) => t.status !== "live")) {
      // T24 is "deepen" in the pack but ships a NEW form id; its live form is qp_foundry_forging.
      const expected = e.status === "deepen" && e.packId !== "qp_foundry_casting" ? 1 : 0;
      expect(VOICE_READY_THROUGH_VERSION[e.packId], e.code).toBe(expected);
    }
  });

  it("reads a version against its row, and treats every other form as voice ready", () => {
    expect(isPackVersionVoiceReady("qp_edm_wirecut", 1)).toBe(true);
    expect(isPackVersionVoiceReady("qp_edm_wirecut", 2)).toBe(false);
    expect(isPackVersionVoiceReady("qp_cmm", 1)).toBe(false);
    expect(isPackVersionVoiceReady("qp_cnc_turning", 6)).toBe(true);
    expect(isPackVersionVoiceReady("qp_universal", 8)).toBe(true);
    expect(isPackVersionVoiceReady("qp_foundry_forging", 1)).toBe(true);
  });
});
