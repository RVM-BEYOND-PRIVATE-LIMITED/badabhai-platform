/**
 * #2749 — the credit-lot sources. `packages/db` spells this set into `credit_lots_source_chk`
 * (its migration test pins that copy to this one), so this file pins the set itself.
 */
import { describe, expect, it } from "vitest";

import { CREDIT_LOT_EXPIRY_TRIGGERS, CREDIT_LOT_SOURCES, isCreditLotSource } from "./index";

describe("credit lot sources", () => {
  it("are the brief's six, frozen", () => {
    expect(CREDIT_LOT_SOURCES).toEqual([
      "pack",
      "welcome",
      "goodwill",
      "returned",
      "migrated",
      "legacy",
    ]);
    expect(Object.isFrozen(CREDIT_LOT_SOURCES)).toBe(true);
  });

  it("an expiry is closed by a spend or by the sweep, frozen (payer.credits_expired v1)", () => {
    expect(CREDIT_LOT_EXPIRY_TRIGGERS).toEqual(["spend", "sweep"]);
    expect(Object.isFrozen(CREDIT_LOT_EXPIRY_TRIGGERS)).toBe(true);
  });

  it("isCreditLotSource admits the set and nothing else", () => {
    for (const source of CREDIT_LOT_SOURCES) expect(isCreditLotSource(source)).toBe(true);
    for (const other of ["Pack", "grant", "expired", "", null, undefined, 0, {}]) {
      expect(isCreditLotSource(other)).toBe(false);
    }
  });
});
