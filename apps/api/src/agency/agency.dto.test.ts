import { describe, it, expect } from "vitest";
import { CreateAgencyJobSchema, UpdateAgencyJobSchema } from "./agency.dto";

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

/**
 * ADR-0024 final addendum (2026-07-16) — the fail-closed write-path guard on
 * worker-visible free text. EVERY free-text surface (title, description, each
 * benefits/requirements item) is screened with BOTH heuristics: `looksLikePii`
 * (phone/email shapes) AND `looksLikeOrgName` (legal-entity suffixes). A phone
 * number or a "Pvt Ltd"-style employer name is rejected with a clear 400 (the
 * message names the FIELD, never the offending content) and is NEVER stored.
 */
describe("Agency job worker-visible free-text guards (ADR-0024 final addendum)", () => {
  it("rejects a description containing a phone number, naming the field", () => {
    const r = CreateAgencyJobSchema.safeParse({
      ...base,
      description: "Call 9876543210 for details",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.message).toBe("remove contact details from the description");
    }
  });

  it("rejects a description containing a company name (Pvt Ltd)", () => {
    const r = CreateAgencyJobSchema.safeParse({
      ...base,
      description: "Work the night line at Sharma Precision Pvt Ltd",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.message).toBe("description must not contain a company name");
    }
  });

  it("rejects a description containing a link (www./TLD shapes — ADR-0024 'contact links')", () => {
    const r = CreateAgencyJobSchema.safeParse({
      ...base,
      description: "Apply at www.acme.in before Friday",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.message).toBe("description must not contain links");
    }
  });

  it("rejects a benefits item containing a URL", () => {
    const r = CreateAgencyJobSchema.safeParse({
      ...base,
      benefits: ["PF + ESI", "Form at https://acme.example/hr"],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.message).toBe("benefits must not contain links");
    }
  });

  it("rejects a benefits item containing a company name", () => {
    const r = CreateAgencyJobSchema.safeParse({
      ...base,
      benefits: ["PF + ESI", "Bus from Acme Private Limited"],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.message).toBe("benefits must not contain a company name");
    }
  });

  it("rejects a requirements item containing contact details", () => {
    const r = CreateAgencyJobSchema.safeParse({
      ...base,
      requirements: ["WhatsApp 98765 43210 to apply"],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.message).toBe("remove contact details from requirements");
    }
  });

  it("rejects a title containing 'Pvt Ltd'", () => {
    const r = CreateAgencyJobSchema.safeParse({ ...base, title: "Operator at Kalyani Pvt Ltd" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]!.message).toBe("title must not contain a company name");
    }
  });

  it("accepts a valid payload with all four new fields (org-safe trade text passes)", () => {
    const r = CreateAgencyJobSchema.safeParse({
      ...base,
      description: "Operate and set VMC machines on the day line.",
      shift: "rotational",
      // "limited experience ok" / "co-worker" are the documented heuristic
      // negatives — legitimate trade text must never 400.
      benefits: ["PF + ESI", "Canteen", "limited experience ok"],
      requirements: ["Fanuc control", "ITI / Diploma", "co-worker friendly"],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.description).toBe("Operate and set VMC machines on the day line.");
      expect(r.data.shift).toBe("rotational");
      expect(r.data.benefits).toEqual(["PF + ESI", "Canteen", "limited experience ok"]);
      expect(r.data.requirements).toEqual(["Fanuc control", "ITI / Diploma", "co-worker friendly"]);
    }
  });

  it("rejects an unknown shift value (enum, not free text)", () => {
    expect(CreateAgencyJobSchema.safeParse({ ...base, shift: "evening" }).success).toBe(false);
  });

  it("caps list size (12 items) and item length (80 chars)", () => {
    expect(
      CreateAgencyJobSchema.safeParse({ ...base, benefits: Array(13).fill("PF") }).success,
    ).toBe(false);
    expect(
      CreateAgencyJobSchema.safeParse({ ...base, requirements: ["x".repeat(81)] }).success,
    ).toBe(false);
  });

  it("UpdateAgencyJobSchema applies the SAME guards to the new fields", () => {
    expect(UpdateAgencyJobSchema.safeParse({ description: "Call 9876543210" }).success).toBe(
      false,
    );
    expect(
      UpdateAgencyJobSchema.safeParse({
        requirements: ["Report to Deccan Auto Components Private Limited"],
      }).success,
    ).toBe(false);
    expect(UpdateAgencyJobSchema.safeParse({ title: "Fitter at Mehta & Co" }).success).toBe(false);
    expect(UpdateAgencyJobSchema.safeParse({ shift: "day" }).success).toBe(true);
    expect(
      UpdateAgencyJobSchema.safeParse({ description: "Day-shift VMC setting role." }).success,
    ).toBe(true);
  });
});
