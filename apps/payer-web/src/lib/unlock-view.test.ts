import { describe, expect, it } from "vitest";
import type { MaskedResumeResult, UnlockResult } from "./contracts";
import {
  NEUTRAL_REVEAL_MESSAGE,
  NEUTRAL_UNLOCK_MESSAGE,
  mapRevealResult,
  mapUnlockResult,
} from "./unlock-view";

describe("unlock-view (no-oracle, XB-C)", () => {
  it("maps a granted unlock to the granted view", () => {
    const r: UnlockResult = {
      ok: true,
      unlockId: "11111111-1111-4111-8111-111111111111",
      status: "granted",
      expiresAt: "2026-07-01T00:00:00.000Z",
    };
    const v = mapUnlockResult(r);
    expect(v.kind).toBe("granted");
  });

  it("maps the neutral unlock body to the SINGLE unavailable view", () => {
    const v = mapUnlockResult({ status: "unavailable" });
    expect(v).toEqual({ kind: "unavailable", message: NEUTRAL_UNLOCK_MESSAGE });
  });

  it("the neutral view carries no cause-distinguishing field", () => {
    const v = mapUnlockResult({ status: "unavailable" });
    // Only kind + message — nothing that could hint at the deny cause.
    expect(Object.keys(v).sort()).toEqual(["kind", "message"]);
  });

  it("maps a disclosed masked resume to the masked view (initials, no phone)", () => {
    const r: MaskedResumeResult = {
      ok: true,
      disclosureId: "22222222-2222-4222-8222-222222222222",
      status: "disclosed",
      displayInitials: "R***** K.",
      resumeUrl: "https://staging.example/masked.pdf",
      expiresAt: "2026-07-01T00:00:00.000Z",
    };
    const v = mapRevealResult(r);
    expect(v.kind).toBe("masked");
    if (v.kind === "masked") {
      expect(v.displayInitials).toBe("R***** K.");
      // The view shape has no phone/name field at all.
      expect(Object.keys(v).sort()).toEqual([
        "disclosureId",
        "displayInitials",
        "expiresAt",
        "kind",
        "resumeUrl",
      ]);
    }
  });

  it("maps the neutral reveal body to the single unavailable view", () => {
    const v = mapRevealResult({ status: "unavailable" });
    expect(v).toEqual({ kind: "unavailable", message: NEUTRAL_REVEAL_MESSAGE });
  });
});
