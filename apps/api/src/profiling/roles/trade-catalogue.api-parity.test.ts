/**
 * Trade catalogue API parity (#2998) — the catalogue row ⇔ the API's role lists.
 *
 * For every loaded catalogue entry: a role descriptor exists with the same pack
 * and family, a résumé map exists for the pack, and FAMILY_CHIP_LABELS has the
 * family. New trades (above LOADED_WAVE) gain all three with their wave issues
 * (#3004 descriptors and chip labels, #3012 résumé maps); until then they are
 * unchecked here.
 */
import { describe, expect, it } from "vitest";
import { LOADED_WAVE, TRADE_CATALOGUE } from "@badabhai/taxonomy";

import { FAMILY_CHIP_LABELS } from "../../occupation/family-chip-labels";
import { tradeResumeMapFor } from "../../resume/trade-resume-map";
import { descriptorForKind } from "./role-registry";

const loaded = TRADE_CATALOGUE.filter((e) => e.wave <= LOADED_WAVE);

describe("trade catalogue API parity", () => {
  it("every loaded trade has a role descriptor with the same pack and family", () => {
    expect(loaded.length).toBeGreaterThan(0);
    for (const e of loaded) {
      const descriptor = descriptorForKind(e.roleKind);
      expect(descriptor, `${e.code} has no role descriptor`).toBeDefined();
      expect(descriptor?.packId).toBe(e.packId);
      expect(descriptor?.familyId).toBe(e.familyId);
    }
  });

  it("every loaded pack has a résumé map", () => {
    for (const e of loaded) {
      expect(tradeResumeMapFor(e.packId), `${e.code} has no résumé map`).toBeDefined();
    }
  });

  it("every loaded family has a chip label", () => {
    for (const e of loaded) {
      expect(FAMILY_CHIP_LABELS[e.familyId], `${e.code} has no chip label`).toBeDefined();
    }
  });
});

/**
 * Trade catalogue API parity — Wave 2 (#3016), checked ahead of LOADED_WAVE. The descriptors
 * land with #3004, the résumé maps with #3012's Wave 2 step, and the chip labels with their own
 * slice; until the wave loads, this block holds all three to the catalogue row.
 */
const wave2 = TRADE_CATALOGUE.filter((e) => e.wave === 2);

describe("trade catalogue API parity — Wave 2 (#3016)", () => {
  it("covers the 18 trades #3016 loads", () => {
    expect(wave2.map((e) => e.code)).toEqual([
      "T18",
      "T19",
      "T20",
      "T22",
      "T23",
      "T28",
      "T30",
      "T31",
      "T32",
      "T34",
      "T35",
      "T36",
      "T39",
      "T40",
      "T41",
      "T42",
      "T56",
      "T57",
    ]);
  });

  it("every Wave 2 trade has a role descriptor with the same pack and family", () => {
    for (const e of wave2) {
      const descriptor = descriptorForKind(e.roleKind);
      expect(descriptor, `${e.code} has no role descriptor`).toBeDefined();
      expect(descriptor?.packId).toBe(e.packId);
      expect(descriptor?.familyId).toBe(e.familyId);
    }
  });

  it("every Wave 2 pack has a résumé map", () => {
    for (const e of wave2) {
      expect(tradeResumeMapFor(e.packId), `${e.code} has no résumé map`).toBeDefined();
    }
  });

  it("every Wave 2 family has a chip label", () => {
    for (const e of wave2) {
      expect(FAMILY_CHIP_LABELS[e.familyId], `${e.code} has no chip label`).toBeDefined();
    }
  });
});
