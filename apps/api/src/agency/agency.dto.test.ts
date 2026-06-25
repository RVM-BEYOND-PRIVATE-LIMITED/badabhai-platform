import { describe, it, expect } from "vitest";
import { CreateAgencyJobSchema } from "./agency.dto";

/**
 * C10 — numeric upper bounds on the agency-job demand fields (anti-abuse / overflow
 * guards, NOT business rules). The values MUST stay in parity with the payer-web mirror
 * `agencyJobInputSchema` (apps/payer-web/src/lib/contracts.ts): pay ≤ ₹10,000,000/month,
 * experience ≤ 60 years. These tests pin the at-bound (accepted) and over-bound (rejected)
 * edges, and confirm the existing cross-field .refine() ordering rules still hold.
 */
const PAY_MAX_INR = 10_000_000;
const EXPERIENCE_MAX_YEARS = 60;

const base = { trade_key: "cnc_operator", title: "CNC Operator", city: "Pune" } as const;

describe("CreateAgencyJobSchema — C10 numeric upper bounds", () => {
  it("accepts pay/experience exactly AT the bound", () => {
    const r = CreateAgencyJobSchema.safeParse({
      ...base,
      pay_min: 0,
      pay_max: PAY_MAX_INR,
      min_experience_years: 0,
      max_experience_years: EXPERIENCE_MAX_YEARS,
    });
    expect(r.success).toBe(true);
  });

  it("rejects pay_max OVER the ₹ ceiling", () => {
    const r = CreateAgencyJobSchema.safeParse({ ...base, pay_max: PAY_MAX_INR + 1 });
    expect(r.success).toBe(false);
  });

  it("rejects pay_min OVER the ₹ ceiling", () => {
    const r = CreateAgencyJobSchema.safeParse({ ...base, pay_min: PAY_MAX_INR + 1 });
    expect(r.success).toBe(false);
  });

  it("rejects max_experience_years OVER the years ceiling", () => {
    const r = CreateAgencyJobSchema.safeParse({ ...base, max_experience_years: EXPERIENCE_MAX_YEARS + 1 });
    expect(r.success).toBe(false);
  });

  it("rejects min_experience_years OVER the years ceiling", () => {
    const r = CreateAgencyJobSchema.safeParse({ ...base, min_experience_years: EXPERIENCE_MAX_YEARS + 1 });
    expect(r.success).toBe(false);
  });

  it("still enforces the cross-field ordering rules (pay_max >= pay_min, maxExp >= minExp)", () => {
    expect(CreateAgencyJobSchema.safeParse({ ...base, pay_min: 50000, pay_max: 40000 }).success).toBe(false);
    expect(
      CreateAgencyJobSchema.safeParse({ ...base, min_experience_years: 5, max_experience_years: 3 }).success,
    ).toBe(false);
  });
});
