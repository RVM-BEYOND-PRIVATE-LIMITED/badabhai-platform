import { describe, expect, it } from "vitest";
import { encodeCandidateCursor } from "./candidate-search.cursor";
import {
  CANDIDATE_SEARCH_DEFAULT_LIMIT,
  CandidateSearchSchema,
  EXPERIENCE_BUCKETS,
  experienceRange,
} from "./candidate-search.dto";

const WORKER = "face2000-0000-4000-8000-000000000001";

describe("CandidateSearchSchema", () => {
  it("an empty body is the unfiltered, reordering first page", () => {
    expect(CandidateSearchSchema.parse({})).toEqual({
      skill_ids: [],
      experience: null,
      industry_id: null,
      industry_experience: null,
      city: null,
      strict: false,
      limit: CANDIDATE_SEARCH_DEFAULT_LIMIT,
      cursor: null,
    });
  });

  it("strict is OFF unless the body asks for it (ADR-0040 Decision 2 — never a default)", () => {
    expect(CandidateSearchSchema.parse({ skill_ids: ["mskill_cnc_turner"] }).strict).toBe(false);
    expect(CandidateSearchSchema.parse({ strict: true }).strict).toBe(true);
  });

  it("refuses a smuggled payer id (.strict(), XB-A)", () => {
    expect(CandidateSearchSchema.safeParse({ payer_id: WORKER }).success).toBe(false);
    expect(CandidateSearchSchema.safeParse({ payerId: WORKER }).success).toBe(false);
  });

  it("refuses an unknown role, a free-text role and a duplicate — never ignores them", () => {
    expect(CandidateSearchSchema.safeParse({ skill_ids: ["mskill_astronaut"] }).success).toBe(false);
    expect(CandidateSearchSchema.safeParse({ skill_ids: ["CNC Turner"] }).success).toBe(false);
    expect(
      CandidateSearchSchema.safeParse({ skill_ids: ["mskill_cnc_turner", "mskill_cnc_turner"] })
        .success,
    ).toBe(false);
  });

  it("caps the roles at five", () => {
    const six = [
      "mskill_cnc_turner",
      "mskill_vmc_operator",
      "mskill_hmc_operator",
      "mskill_cnc_setter_operator",
      "mskill_cnc_programmer",
      "mskill_cam_programmer",
    ];
    expect(CandidateSearchSchema.safeParse({ skill_ids: six.slice(0, 5) }).success).toBe(true);
    expect(CandidateSearchSchema.safeParse({ skill_ids: six }).success).toBe(false);
  });

  it("accepts only the closed buckets and industries", () => {
    expect(CandidateSearchSchema.safeParse({ experience: "3_5" }).success).toBe(true);
    expect(CandidateSearchSchema.safeParse({ experience: "4" }).success).toBe(false);
    expect(CandidateSearchSchema.safeParse({ industry_experience: 48 }).success).toBe(false);
    expect(
      CandidateSearchSchema.safeParse({ industry_id: "ind_industrial_manufacturing" }).success,
    ).toBe(true);
    expect(CandidateSearchSchema.safeParse({ industry_id: "ind_space" }).success).toBe(false);
  });

  it("trims the city and refuses an empty or over-long one", () => {
    expect(CandidateSearchSchema.parse({ city: "  Pune " }).city).toBe("Pune");
    expect(CandidateSearchSchema.safeParse({ city: "   " }).success).toBe(false);
    expect(CandidateSearchSchema.safeParse({ city: "x".repeat(81) }).success).toBe(false);
  });

  it("bounds the page size to 1..50", () => {
    expect(CandidateSearchSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(CandidateSearchSchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(CandidateSearchSchema.parse({ limit: 50 }).limit).toBe(50);
  });

  it("decodes a minted cursor and refuses one the server never minted", () => {
    const minted = encodeCandidateCursor({
      fingerprint: "KtU6VRlIU-F5mAVibSQGym",
      workerId: WORKER,
      served: 20,
    });
    expect(CandidateSearchSchema.parse({ cursor: minted }).cursor).toMatchObject({ workerId: WORKER });
    expect(CandidateSearchSchema.safeParse({ cursor: "forged" }).success).toBe(false);
  });
});

describe("EXPERIENCE_BUCKETS", () => {
  it("tiles 0 months upward with no gap or overlap, every edge a multiple of 6 months", () => {
    let expectedMin = 0;
    for (const bucket of EXPERIENCE_BUCKETS) {
      expect(bucket.minMonths).toBe(expectedMin);
      expect(bucket.minMonths % 6).toBe(0);
      if (bucket.maxMonths !== null) {
        expect(bucket.maxMonths % 6).toBe(0);
        expect(bucket.maxMonths).toBeGreaterThan(bucket.minMonths);
        expectedMin = bucket.maxMonths;
      }
    }
    expect(EXPERIENCE_BUCKETS.at(-1)?.maxMonths).toBeNull();
  });

  it("experienceRange returns the [min, max) months of a bucket", () => {
    expect(experienceRange("1_3")).toEqual({ min: 12, max: 36 });
    expect(experienceRange("10_plus")).toEqual({ min: 120, max: null });
  });
});
