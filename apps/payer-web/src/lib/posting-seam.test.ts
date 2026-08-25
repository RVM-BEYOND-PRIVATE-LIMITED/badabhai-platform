import { describe, expect, it } from "vitest";
import { toPayerJobPostingBody, toPayerJobPostingPatchBody } from "./payer-api";
import type { CreatePostingInput, UpdatePostingInput } from "./contracts";

/**
 * EMPLOYER posting LIVE-body contract tests. `createPosting` is now LIVE (it POSTs
 * `toPayerJobPostingBody(input, <session org>)` to `/payer/job-postings`) and `updatePosting`
 * PATCHes `toPayerJobPostingPatchBody(input)` — these tests pin the PURE body mappers against
 * the backend `PayerCreateJobPostingSchema` / `UpdateJobPostingSchema` shapes
 * (apps/api/src/job-postings/job-postings.dto.ts); the live fetch wiring (URL/method/Bearer)
 * is covered separately in payer-api.test.ts.
 *
 * The CREATE schema is NARROWER than UPDATE. Create accepts EXACTLY org_label/role_title
 * (required) + location_label/description? + EXACTLY ONE of vacancy_band|vacancies, and has NO
 * payer_id/created_by (XB-A). The UPDATE schema is WIDER: it ALSO accepts the worker-visible
 * display fields city/pay_min/pay_max/shift/needed_by (migration 0054). These tests fail loudly
 * if a body drifts from its OWN schema — a create body must never smuggle pay (create rejects
 * it), and NEITHER body may carry trade/exp/state (no schema accepts them) or a client tenancy
 * id. The PATCH body additionally drops org_label (the session identity is not edited).
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

// A full EDIT input exercising the fields the UPDATE schema accepts that create does NOT
// (city/shift/needed_by, on top of pay). Typed as UpdatePostingInput — CreatePostingInput has
// no city/shift/neededBy, so this is the shape that pins the wider PATCH mapping.
const FULL_UPDATE_INPUT: UpdatePostingInput = {
  roleTitle: "CNC Machinist",
  vacancies: 7,
  locationLabel: "Pune, MH",
  description: "Two-shift CNC role, PPE provided.",
  city: "Pune",
  payMin: 20000,
  payMax: 35000,
  shift: "rotational",
  neededBy: "immediate",
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

// The full set of keys UpdateJobPostingSchema accepts (mirrored from the backend DTO). WIDER
// than create: it includes the worker-visible display fields (city/pay_min/pay_max/shift/
// needed_by). match_skill_ids/unticked_related_ids ride the SEPARATE publish body, not this one.
const PATCH_ALLOWED_KEYS = new Set([
  "org_label",
  "role_title",
  "location_label",
  "description",
  "vacancy_band",
  "vacancies",
  "status",
  "city",
  "pay_min",
  "pay_max",
  "shift",
  "needed_by",
]);

describe("toPayerJobPostingPatchBody — matches UpdateJobPostingSchema (edit)", () => {
  it("sends the RAW vacancies count (never a band), and NO org_label (session identity isn't edited)", () => {
    const body = toPayerJobPostingPatchBody(FULL_INPUT);
    expect(body.vacancies).toBe(7);
    expect(body).not.toHaveProperty("vacancy_band");
    // The PATCH never re-stamps org_label — the org is the session identity, not an edit field.
    expect(body).not.toHaveProperty("org_label");
  });

  it("NEVER carries payer_id / created_by (XB-A — the session is owner+creator)", () => {
    for (const body of [toPayerJobPostingPatchBody(FULL_INPUT), toPayerJobPostingPatchBody(MINIMAL_INPUT)]) {
      expect(body).not.toHaveProperty("payer_id");
      expect(body).not.toHaveProperty("created_by");
    }
  });

  it("passes pay STRAIGHT THROUGH (snake_case) — the UPDATE schema accepts it, unlike create", () => {
    const body = toPayerJobPostingPatchBody(FULL_INPUT);
    expect(body.pay_min).toBe(20000);
    expect(body.pay_max).toBe(35000);
    // camelCase never leaks and nothing invented a price.
    expect(body).not.toHaveProperty("payMin");
    expect(body).not.toHaveProperty("payMax");
  });

  it("maps the wider worker-visible fields (city/shift/needed_by) to snake_case", () => {
    const body = toPayerJobPostingPatchBody(FULL_UPDATE_INPUT);
    expect(body.city).toBe("Pune");
    expect(body.shift).toBe("rotational");
    expect(body.needed_by).toBe("immediate");
    expect(body.pay_min).toBe(20000);
    expect(body.pay_max).toBe(35000);
    // camelCase originals never leak onto the wire.
    for (const k of ["neededBy", "payMin", "payMax"]) expect(body).not.toHaveProperty(k);
  });

  it("does NOT leak the fields NO schema accepts (trade/exp/state)", () => {
    const body = toPayerJobPostingPatchBody(FULL_INPUT);
    for (const k of ["trade_key", "state", "min_experience_years", "max_experience_years"]) {
      expect(body).not.toHaveProperty(k);
    }
  });

  it("every emitted key is in the UpdateJobPostingSchema accepted set", () => {
    for (const body of [
      toPayerJobPostingPatchBody(FULL_INPUT),
      toPayerJobPostingPatchBody(MINIMAL_INPUT),
      toPayerJobPostingPatchBody(FULL_UPDATE_INPUT),
    ]) {
      for (const key of Object.keys(body)) {
        expect(PATCH_ALLOWED_KEYS.has(key)).toBe(true);
      }
      expect(body).toHaveProperty("role_title");
    }
  });

  it("omits optional fields when absent (minimal edit carries only meaningful keys)", () => {
    const body = toPayerJobPostingPatchBody(MINIMAL_INPUT);
    expect(body).not.toHaveProperty("location_label");
    expect(body).not.toHaveProperty("description");
    for (const k of ["city", "pay_min", "pay_max", "shift", "needed_by"]) {
      expect(body).not.toHaveProperty(k);
    }
    expect(Object.keys(body).sort()).toEqual(["role_title", "vacancies"]);
  });
});
