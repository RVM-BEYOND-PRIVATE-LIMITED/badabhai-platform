import { describe, expect, it } from "vitest";
import type { PostingTradeFormWire } from "./contracts";
import { canFindMatching, matchingWorkersHref, offeredCity } from "./job-matching";

const TRADE: PostingTradeFormWire = {
  role_kind: "cnc_turner",
  role_label: "CNC Turner",
  pack_id: "qp_cnc_turner",
  match_skill_id: "mskill_cnc_turner",
  ladder: [],
  questions: [],
};

const CITIES = ["Pune", "Nashik"];

describe("canFindMatching", () => {
  it("offers the button on open and paused jobs only", () => {
    expect(canFindMatching("open")).toBe(true);
    expect(canFindMatching("paused")).toBe(true);
    for (const status of ["draft", "closed", "suspended"]) {
      expect(canFindMatching(status)).toBe(false);
    }
  });
});

describe("offeredCity", () => {
  it("returns the filters' own spelling, case-insensitively", () => {
    expect(offeredCity(CITIES, "pune")).toBe("Pune");
    expect(offeredCity(CITIES, "  NASHIK ")).toBe("Nashik");
  });

  it("drops a city the options do not list, a blank one, or any city when the read failed", () => {
    expect(offeredCity(CITIES, "Mumbai")).toBeNull();
    expect(offeredCity(CITIES, "   ")).toBeNull();
    expect(offeredCity(CITIES, null)).toBeNull();
    expect(offeredCity(null, "Pune")).toBeNull();
  });
});

describe("matchingWorkersHref", () => {
  it("sends the trade's own match skill, the listed city and strict mode", () => {
    expect(
      matchingWorkersHref({
        status: "open",
        roleKind: "cnc_turner",
        jobCity: "pune",
        trades: [TRADE],
        cities: CITIES,
      }),
    ).toBe("/candidates?role=mskill_cnc_turner&city=Pune&strict=1");
  });

  it("leaves an unlisted city out rather than let the search 400", () => {
    expect(
      matchingWorkersHref({
        status: "paused",
        roleKind: "cnc_turner",
        jobCity: "Mumbai",
        trades: [TRADE],
        cities: CITIES,
      }),
    ).toBe("/candidates?role=mskill_cnc_turner&strict=1");
  });

  it("drops the city when the filters could not be read", () => {
    expect(
      matchingWorkersHref({
        status: "open",
        roleKind: "cnc_turner",
        jobCity: "Pune",
        trades: [TRADE],
        cities: null,
      }),
    ).toBe("/candidates?role=mskill_cnc_turner&strict=1");
  });

  it("is null for a draft, a closed job, a non-16 role and a job with no role", () => {
    const base = {
      roleKind: "cnc_turner",
      jobCity: "Pune",
      trades: [TRADE],
      cities: CITIES,
    };
    expect(matchingWorkersHref({ ...base, status: "draft" })).toBeNull();
    expect(matchingWorkersHref({ ...base, status: "closed" })).toBeNull();
    expect(matchingWorkersHref({ ...base, status: "open", roleKind: "designer" })).toBeNull();
    expect(matchingWorkersHref({ ...base, status: "open", roleKind: null })).toBeNull();
  });
});
