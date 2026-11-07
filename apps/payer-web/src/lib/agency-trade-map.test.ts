import { describe, expect, it } from "vitest";
import { TRADE_KEYS, type TradeKey } from "./contracts";
import { AGENCY_TRADE_KEY_BY_ROLE_KIND, tradeKeyForRoleKind } from "./agency-trade-map";

/** The 16-trade posting catalogue (packages/taxonomy POSTING_TRADE_KINDS). */
const POSTING_TRADE_KINDS = [
  "cnc_turner",
  "vmc_milling",
  "cnc_grinding",
  "cam_programmer",
  "cad_draughtsman",
  "conventional_machinist",
  "tool_die_maker",
  "welder",
  "sheet_metal_worker",
  "press_operator",
  "painter_coating",
  "fitter",
  "maintenance_technician",
  "industrial_electrician",
  "assembly_line_worker",
  "quality_inspector",
] as const;

describe("agency role_kind -> trade_key map (#2718)", () => {
  it("covers every one of the 16 posting-trade roles", () => {
    expect(Object.keys(AGENCY_TRADE_KEY_BY_ROLE_KIND).sort()).toEqual(
      [...POSTING_TRADE_KINDS].sort(),
    );
  });

  it("only ever sends one of the 15 agency trade keys", () => {
    const allowed = new Set<string>(TRADE_KEYS);
    for (const tradeKey of Object.values(AGENCY_TRADE_KEY_BY_ROLE_KIND)) {
      expect(allowed.has(tradeKey)).toBe(true);
    }
  });

  it("derives the ratified mapping and nothing else", () => {
    expect(tradeKeyForRoleKind("cnc_turner")).toBe("cnc_operator");
    expect(tradeKeyForRoleKind("vmc_milling")).toBe("vmc_operator");
    expect(tradeKeyForRoleKind("cnc_grinding")).toBe("cnc_operator");
    expect(tradeKeyForRoleKind("cam_programmer")).toBe("cnc_programmer");
    expect(tradeKeyForRoleKind("cad_draughtsman")).toBe("autocad_draftsman");
    expect(tradeKeyForRoleKind("conventional_machinist")).toBe("machine_operator");
    expect(tradeKeyForRoleKind("tool_die_maker")).toBe("tool_room_technician");
    expect(tradeKeyForRoleKind("welder")).toBe("machine_operator");
    expect(tradeKeyForRoleKind("sheet_metal_worker")).toBe("machine_operator");
    expect(tradeKeyForRoleKind("press_operator")).toBe("machine_operator");
    expect(tradeKeyForRoleKind("painter_coating")).toBe("machine_operator");
    expect(tradeKeyForRoleKind("fitter")).toBe("fitter");
    expect(tradeKeyForRoleKind("maintenance_technician")).toBe("maintenance_technician");
    expect(tradeKeyForRoleKind("industrial_electrician")).toBe("maintenance_technician");
    expect(tradeKeyForRoleKind("assembly_line_worker")).toBe("assembly_technician");
    expect(tradeKeyForRoleKind("quality_inspector")).toBe("quality_inspector");
  });

  it("returns null when no role is picked or the role is not in the catalogue", () => {
    expect(tradeKeyForRoleKind("")).toBeNull();
    expect(tradeKeyForRoleKind("not_a_role")).toBeNull();
  });

  it("types every value as a TradeKey", () => {
    const keys: TradeKey[] = Object.values(AGENCY_TRADE_KEY_BY_ROLE_KIND);
    expect(keys).toHaveLength(16);
  });
});
