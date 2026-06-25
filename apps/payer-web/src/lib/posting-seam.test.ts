import { describe, expect, it } from "vitest";
import { toPayerJobPostingBody } from "./payer-api";
import type { CreatePostingInput } from "./contracts";

/**
 * EMPLOYER posting LIVE-body contract tests. `createPosting` stays mock for now (the
 * dashboard/list still read the mock store), so there is no `payerFetch` body to assert
 * via a fetch mock the way the agency seam does — instead we pin the PURE mapper that the
 * live swap will use, {@link toPayerJobPostingBody}, against the backend
 * `PayerCreateJobPostingSchema` shape (apps/api/src/job-postings/job-postings.dto.ts).
 *
 * The backend schema accepts EXACTLY these keys (org_label/role_title required;
 * location_label/description optional; EXACTLY ONE of vacancy_band|vacancies) and has NO
 * payer_id/created_by (XB-A: the verified session is owner+creator). These tests fail
 * loudly if the body ever drifts from that contract — including smuggling a client tenancy
 * id or the not-yet-accepted trade/pay/exp demand fields.
 */

// The full set of keys PayerCreateJobPostingSchema accepts (mirrored from the backend DTO).
const ALLOWED_KEYS = new Set([
  "org_label",
  "role_title",
  "location_label",
  "description",
  "vacancy_band",
  "vacancies",
]);

const ORG = "Acme Manufacturing";

const FULL_INPUT: CreatePostingInput = {
  tradeKey: "cnc_operator",
  roleTitle: "CNC Machinist",
  locationLabel: "Pune, MH",
  description: "Two-shift CNC role, PPE provided.",
  vacancies: 7,
  payMin: 20000,
  payMax: 35000,
  minExperienceYears: 1,
  maxExperienceYears: 5,
};

const MINIMAL_INPUT: CreatePostingInput = {
  tradeKey: "fitter",
  roleTitle: "Fitter",
  vacancies: 1,
};

describe("toPayerJobPostingBody — matches PayerCreateJobPostingSchema", () => {
  it("emits EXACTLY ONE of vacancy_band|vacancies (the RAW vacancies count, never a band)", () => {
    const body = toPayerJobPostingBody(FULL_INPUT, ORG);
    // The backend refine is (vacancy_band !== undefined) !== (vacancies !== undefined).
    expect(("vacancy_band" in body) !== ("vacancies" in body)).toBe(true);
    expect(body.vacancies).toBe(7); // the raw count
    expect(body).not.toHaveProperty("vacancy_band");
  });

  it("NEVER carries payer_id / created_by (XB-A — the session is owner+creator)", () => {
    for (const body of [toPayerJobPostingBody(FULL_INPUT, ORG), toPayerJobPostingBody(MINIMAL_INPUT, ORG)]) {
      expect(body).not.toHaveProperty("payer_id");
      expect(body).not.toHaveProperty("payerId");
      expect(body).not.toHaveProperty("created_by");
      expect(body).not.toHaveProperty("createdBy");
    }
  });

  it("stamps org_label from the session arg (NOT from the input — there is no form field)", () => {
    const body = toPayerJobPostingBody(FULL_INPUT, ORG);
    expect(body.org_label).toBe(ORG);
    expect(body.role_title).toBe("CNC Machinist");
    expect(body.location_label).toBe("Pune, MH");
    expect(body.description).toBe("Two-shift CNC role, PPE provided.");
  });

  it("does NOT leak the not-yet-accepted demand fields (trade/pay/exp)", () => {
    const body = toPayerJobPostingBody(FULL_INPUT, ORG);
    for (const k of ["trade_key", "tradeKey", "pay_min", "pay_max", "min_experience_years", "max_experience_years"]) {
      expect(body).not.toHaveProperty(k);
    }
  });

  it("every emitted key is in the PayerCreateJobPostingSchema accepted set", () => {
    for (const body of [toPayerJobPostingBody(FULL_INPUT, ORG), toPayerJobPostingBody(MINIMAL_INPUT, ORG)]) {
      for (const key of Object.keys(body)) {
        expect(ALLOWED_KEYS.has(key)).toBe(true);
      }
      // Required keys are always present.
      expect(body).toHaveProperty("org_label");
      expect(body).toHaveProperty("role_title");
    }
  });

  it("omits optional labels when absent (minimal body carries only meaningful keys)", () => {
    const body = toPayerJobPostingBody(MINIMAL_INPUT, ORG);
    expect(body).not.toHaveProperty("location_label");
    expect(body).not.toHaveProperty("description");
    expect(Object.keys(body).sort()).toEqual(["org_label", "role_title", "vacancies"]);
  });
});
