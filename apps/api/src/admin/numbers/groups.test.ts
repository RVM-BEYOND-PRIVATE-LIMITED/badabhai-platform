import { describe, expect, it } from "vitest";
import { ROLES } from "@badabhai/taxonomy";
import { TRADE_FORM_KINDS_ALL } from "@badabhai/types";
import {
  NUMBERS_ALL_GROUP,
  NUMBERS_CITY_GROUPS,
  NUMBERS_CITY_GROUP_LABELS,
  NUMBERS_CITY_GROUP_MEMBERS,
  NUMBERS_CITY_GROUP_TITLES,
  NUMBERS_DEFINITION_VERSION,
  NUMBERS_LAUNCH_CITY_GROUPS,
  NUMBERS_LAUNCH_TRADE_GROUPS,
  NUMBERS_TRADE_GROUPS,
  NUMBERS_TRADE_GROUP_LABELS,
  NUMBERS_TRADE_GROUP_MEMBERS,
  NUMBERS_TRADE_GROUP_TITLES,
  cityGroupOf,
  knownTradeKeys,
  normalizeCityName,
  tradeGroupOf,
} from "./groups";

/** #2755 item 3 — the city and trade groups: versioned code, honest `other` and `unknown`. */

describe("the definition version", () => {
  it("is 4 since the posting-button shares went live (a change to any list bumps it in the same pull request)", () => {
    expect(NUMBERS_DEFINITION_VERSION).toBe(4);
  });
});

describe("cityGroupOf — stored free text to a city group", () => {
  it.each([
    ["Delhi", "ncr"],
    ["New Delhi", "ncr"],
    ["  new   DELHI ", "ncr"],
    ["Dilli", "ncr"],
    ["Delhi NCR", "ncr"],
    ["Faridabad", "ncr"],
    ["Gurugram", "ncr"],
    ["Gurgaon", "ncr"],
    ["Gudgaon", "ncr"],
    ["Noida", "ncr"],
    ["Greater Noida", "ncr"],
    ["greater-noida", "ncr"],
    ["Ghaziabad", "ncr"],
    ["Noida, Uttar Pradesh", "ncr"],
    ["Pune", "pune"],
    ["Poona", "pune"],
    ["Pimpri-Chinchwad", "pune"],
    ["pimpri chinchwad", "pune"],
    ["Chakan", "pune"],
    ["Ahmedabad", "ahmedabad"],
    ["Amdavad", "ahmedabad"],
    ["Sanand", "ahmedabad"],
    ["Gandhinagar", "ahmedabad"],
    ["Mumbai", "other"],
    ["Chennai", "other"],
    ["Manesar", "other"],
    ["Bhiwadi", "other"],
    ["Noida Sector 62", "other"],
    ["", "unknown"],
    ["   ", "unknown"],
    [", Haryana", "unknown"],
    [null, "unknown"],
    [undefined, "unknown"],
  ] as const)("%j → %s", (raw, group) => {
    expect(cityGroupOf(raw)).toBe(group);
  });

  it("is case-, whitespace- and width-insensitive (NFKC)", () => {
    expect(cityGroupOf("ＰＵＮＥ")).toBe("pune");
    expect(cityGroupOf("\tAhmedabad\n")).toBe("ahmedabad");
  });

  it("never returns the roll-up label", () => {
    for (const raw of ["all", "All", "ALL cities"]) {
      expect(cityGroupOf(raw)).not.toBe(NUMBERS_ALL_GROUP);
    }
  });

  it("every member is already normalised and belongs to exactly one group", () => {
    const seen = new Map<string, string>();
    for (const group of NUMBERS_LAUNCH_CITY_GROUPS) {
      for (const member of NUMBERS_CITY_GROUP_MEMBERS[group]) {
        expect(normalizeCityName(member), member).toBe(member);
        expect(seen.has(member), `${member} is in two groups`).toBe(false);
        seen.set(member, group);
        expect(cityGroupOf(member)).toBe(group);
      }
    }
  });

  it("the brief's NCR list is present, and nothing beyond its towns and their spellings", () => {
    expect([...NUMBERS_CITY_GROUP_MEMBERS.ncr].sort()).toEqual(
      [
        "delhi",
        "new delhi",
        "dilli",
        "dilly",
        "delhi ncr",
        "ncr",
        "faridabad",
        "gurugram",
        "gurgaon",
        "gudgaon",
        "noida",
        "greater noida",
        "ghaziabad",
      ].sort(),
    );
  });
});

describe("tradeGroupOf — a form kind or a taxonomy role to a trade group", () => {
  /** The launch members, written out: a change to the map must change this table too. */
  const LAUNCH: Record<string, string> = {
    cnc_turner: "cnc_operator",
    vmc_milling: "cnc_operator",
    role_cnc_turner_operator: "cnc_operator",
    role_vmc_operator: "cnc_operator",
    role_hmc_operator: "cnc_operator",
    role_cnc_setter_operator: "cnc_operator",
    role_cnc_operator: "cnc_operator",
    cam_programmer: "cnc_cam_programmer",
    role_cam_programmer: "cnc_cam_programmer",
    role_cnc_programmer: "cnc_cam_programmer",
    sheet_metal_worker: "sheet_metal",
    cad_designer_3d: "cad_3d_designer",
    role_cad_designer_3d: "cad_3d_designer",
  };

  it("EXHAUSTIVE: every known form kind and taxonomy role maps to its pinned group", () => {
    // A 28th form kind or a new taxonomy role lands in `other` until someone classifies it here.
    const keys = [...TRADE_FORM_KINDS_ALL, ...ROLES.map((r) => r.id)];
    expect(knownTradeKeys()).toEqual([...new Set(keys)].sort());
    for (const key of keys) {
      expect(tradeGroupOf(key), key).toBe(LAUNCH[key] ?? "other");
    }
  });

  it("the deliberate exclusions are `other`", () => {
    expect(tradeGroupOf("cnc_grinding")).toBe("other");
    expect(tradeGroupOf("role_cnc_grinding_operator")).toBe("other");
    expect(tradeGroupOf("cad_draughtsman")).toBe("other");
    expect(tradeGroupOf("role_designer")).toBe("other");
    expect(tradeGroupOf("press_operator")).toBe("other");
    expect(tradeGroupOf("welder")).toBe("other");
  });

  it("a missing key and a key this code does not know are `unknown`, never a guess", () => {
    for (const key of [
      null,
      undefined,
      "",
      "   ",
      "role_astronaut",
      "CNC_TURNER",
      "cnc operator",
    ]) {
      expect(tradeGroupOf(key), String(key)).toBe("unknown");
    }
    expect(tradeGroupOf(" cnc_turner ")).toBe("cnc_operator");
  });

  it("every member is a REAL key in its key space, and in exactly one group", () => {
    const kinds = new Set<string>(TRADE_FORM_KINDS_ALL);
    const roles = new Set<string>(ROLES.map((r) => r.id));
    const seen = new Set<string>();
    for (const group of NUMBERS_LAUNCH_TRADE_GROUPS) {
      const m = NUMBERS_TRADE_GROUP_MEMBERS[group];
      for (const k of m.roleKinds) expect(kinds.has(k), k).toBe(true);
      for (const r of m.taxonomyRoles) expect(roles.has(r), r).toBe(true);
      for (const key of [...m.roleKinds, ...m.taxonomyRoles]) {
        expect(seen.has(key), `${key} is in two groups`).toBe(false);
        seen.add(key);
      }
    }
  });
});

describe("the label sets", () => {
  it("every group set leads with `all`, then the launch groups, then other and unknown", () => {
    expect(NUMBERS_CITY_GROUP_LABELS).toEqual([
      "all",
      "ncr",
      "pune",
      "ahmedabad",
      "other",
      "unknown",
    ]);
    expect(NUMBERS_TRADE_GROUP_LABELS).toEqual([
      "all",
      "cnc_operator",
      "cnc_cam_programmer",
      "sheet_metal",
      "cad_3d_designer",
      "other",
      "unknown",
    ]);
    expect(NUMBERS_CITY_GROUPS).not.toContain("all");
    expect(NUMBERS_TRADE_GROUPS).not.toContain("all");
  });

  it("every label has a title", () => {
    for (const l of NUMBERS_CITY_GROUP_LABELS) expect(NUMBERS_CITY_GROUP_TITLES[l]).toBeTruthy();
    for (const l of NUMBERS_TRADE_GROUP_LABELS) expect(NUMBERS_TRADE_GROUP_TITLES[l]).toBeTruthy();
  });
});
