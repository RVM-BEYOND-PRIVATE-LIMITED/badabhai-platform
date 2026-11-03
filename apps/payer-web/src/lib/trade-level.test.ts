import { describe, expect, it } from "vitest";
import type { TradeLevelBadgeWire } from "./contracts";
import { shownTradeLevel } from "./trade-level";

/**
 * The ONE rung a faceless card prints (Middle Way P5) — shared by the applicant card and the
 * all-candidates card. Display only: the rung for the trade the card SHOWS, never another's.
 */

const level = (skillId: string, skillLabel: string | null, label: string): TradeLevelBadgeWire => ({
  skillId,
  skillLabel,
  tradeLevel: label.toLowerCase(),
  tradeLevelLabel: label,
  levelConfirmed: true,
});
const TURNER = level("mskill_cnc_turner", "CNC Turner", "Setter");
const VMC = level("mskill_vmc_operator", "VMC Operator", "Helper");

describe("shownTradeLevel", () => {
  it("no rungs (absent or empty) is no badge, never a placeholder", () => {
    expect(shownTradeLevel(undefined, { skillLabel: "CNC Turner" })).toBeNull();
    expect(shownTradeLevel([], { skillId: "mskill_cnc_turner" })).toBeNull();
  });

  it("one rung is that rung", () => {
    expect(shownTradeLevel([VMC], {})).toBe(VMC);
  });

  it("several: the shown trade's — by id (a search row's role), else by label (the applicant card)", () => {
    expect(shownTradeLevel([TURNER, VMC], { skillId: "mskill_vmc_operator", skillLabel: "CNC Turner" })).toBe(VMC);
    expect(shownTradeLevel([TURNER, VMC], { skillLabel: "CNC Turner" })).toBe(TURNER);
    // An id no rung carries falls back to the label.
    expect(shownTradeLevel([TURNER, VMC], { skillId: "mskill_x", skillLabel: "VMC Operator" })).toBe(VMC);
  });

  it("several and none on the shown trade (or no trade to show): none — another trade's would misstate him", () => {
    expect(shownTradeLevel([TURNER, VMC], { skillLabel: "Welder" })).toBeNull();
    expect(shownTradeLevel([TURNER, VMC], {})).toBeNull();
  });
});
