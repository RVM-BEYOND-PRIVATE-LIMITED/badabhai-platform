import { describe, expect, it } from "vitest";
import {
  day,
  experienceBandLabel,
  isActiveJob,
  kAnonCount,
  neededByLabel,
  payBandLabel,
  tradeLabel,
} from "./agency-view";
import type { AgencyJob } from "./contracts";

/**
 * Pins the k-anon surfacing + the coarse, non-PII formatters for the Agency Supply
 * Portal DEMAND surface (ADR-0022). The k-anon case is the security-load-bearing one: a
 * suppressed 0 must read as "<floor", never as a literal 0, so a single named invitee's
 * consent can never be inferred from the funnel (no oracle).
 */

describe("kAnonCount — a suppressed 0 reads as '<floor', never literally zero", () => {
  it("renders a 0 (below-floor) as '<minBucket'", () => {
    expect(kAnonCount(0, 5)).toBe("<5");
  });
  it("renders a count at/above the floor as-is", () => {
    expect(kAnonCount(5, 5)).toBe("5");
    expect(kAnonCount(42, 5)).toBe("42");
  });
  it("honours a different floor echoed by the API", () => {
    expect(kAnonCount(0, 10)).toBe("<10");
  });
});

describe("coarse, non-PII formatters", () => {
  it("formats pay bands without leaking precision beyond whole rupees", () => {
    expect(payBandLabel(null, null)).toBe("—");
    expect(payBandLabel(20000, 35000)).toBe("₹20,000–₹35,000");
    expect(payBandLabel(20000, null)).toBe("₹20,000+");
    expect(payBandLabel(null, 35000)).toBe("up to ₹35,000");
  });
  it("formats experience bands", () => {
    expect(experienceBandLabel(null, null)).toBe("—");
    expect(experienceBandLabel(1, 5)).toBe("1–5 yrs");
    expect(experienceBandLabel(2, null)).toBe("2+ yrs");
    expect(experienceBandLabel(null, 4)).toBe("up to 4 yrs");
  });
  it("labels the coarse timing enum", () => {
    expect(neededByLabel("immediate")).toBe("Immediate");
    expect(neededByLabel("soon")).toBe("Soon");
    expect(neededByLabel("flexible")).toBe("Flexible");
    expect(neededByLabel(null)).toBe("—");
  });
  it("humanises a trade_key slug to Title Case with domain acronyms uppercased", () => {
    expect(tradeLabel("cnc_operator")).toBe("CNC Operator");
    expect(tradeLabel("vmc_programmer")).toBe("VMC Programmer");
    expect(tradeLabel("cnc_vmc_setter")).toBe("CNC VMC Setter");
    expect(tradeLabel("cad_designer")).toBe("CAD Designer");
    expect(tradeLabel("quality_inspector")).toBe("Quality Inspector");
  });
  it("formats a wire timestamp to yyyy-mm-dd and echoes an unparseable value", () => {
    expect(day("2026-06-22T10:30:00.000Z")).toBe("2026-06-22");
    expect(day("not-a-date")).toBe("not-a-date");
  });
});

describe("isActiveJob — only 'open' is active (status is open|closed)", () => {
  const base: AgencyJob = {
    id: "00000000-0000-4000-8000-000000000001",
    status: "open",
    tradeKey: "cnc_operator",
    title: "CNC Operator",
    city: "Pune",
    area: null,
    payMin: null,
    payMax: null,
    minExperienceYears: null,
    maxExperienceYears: null,
    neededBy: null,
    applicantsReceived: 0,
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
  };
  it("treats an open job as active", () => {
    expect(isActiveJob(base)).toBe(true);
  });
  it("treats a closed job as inactive", () => {
    expect(isActiveJob({ ...base, status: "closed" })).toBe(false);
  });
});
