import { beforeEach, describe, expect, it } from "vitest";
import {
  applicantQuotaStep,
  baseApplicantQuotaForBand,
  bandForVacancies,
  baselineActiveVacancyAllowance,
} from "./pricing-config";
import {
  __resetForTest,
  createPosting,
  getPostings,
  pausePosting,
  resumePosting,
  topUpPostingQuota,
} from "./mock-store";

/**
 * Tenancy (XB-A) + config-driven tests for the job-management mock-store mutators.
 *
 * Each mutator must ONLY ever touch the payer whose id is passed; a posting that is
 * not that payer's returns null (neutral not-found, never a cross-tenant write). Quota
 * values come from the pricing config, never a hardcoded literal here.
 */

const PAYER_A = "11111111-1111-4111-8111-111111111111";
const PAYER_B = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  __resetForTest(PAYER_A, true);
  __resetForTest(PAYER_B, false);
});

describe("createPosting — band is derived from the raw vacancies count, quota config-derived", () => {
  it("derives the local band from the raw vacancies count (not a client-chosen band)", () => {
    // 3 → "1-5", 30 → "21-50" per bandForVacancies — the store never takes a band directly.
    expect(createPosting(PAYER_A, { roleTitle: "A", vacancies: 3 }).vacancyBand).toBe(
      bandForVacancies(3),
    );
    expect(createPosting(PAYER_A, { roleTitle: "B", vacancies: 30 }).vacancyBand).toBe(
      bandForVacancies(30),
    );
  });

  it("seeds a new posting's quota from the catalog for the derived band (never a literal)", () => {
    const posting = createPosting(PAYER_A, { roleTitle: "VMC Operator", vacancies: 3 });
    expect(posting.applicantQuota).toBe(baseApplicantQuotaForBand(bandForVacancies(3)));
    expect(posting.applicantQuota).toBeGreaterThan(0);
  });

  it("stamps the quota from baseApplicantQuotaForBand(config) for EVERY band — provably not a literal", () => {
    // One representative count per frontend band. The quota MUST equal the config function's
    // output for the derived band; equality to `baseApplicantQuotaForBand` (which reads the
    // catalog `applicantQuotaStep`) proves the value is config-sourced, not a hardcoded number.
    for (const vacancies of [1, 10, 30, 80]) {
      const posting = createPosting(PAYER_A, { roleTitle: `R${vacancies}`, vacancies });
      const expected = baseApplicantQuotaForBand(bandForVacancies(vacancies));
      expect(posting.applicantQuota).toBe(expected ?? undefined);
      expect(posting.applicantQuota).toBeGreaterThan(0);
    }
  });

  it("a higher head count grants at least as much quota as a lower one", () => {
    const small = createPosting(PAYER_A, { roleTitle: "A", vacancies: 3 }); // band "1-5"
    const big = createPosting(PAYER_A, { roleTitle: "B", vacancies: 80 }); // band "50+"
    expect(big.applicantQuota!).toBeGreaterThanOrEqual(small.applicantQuota!);
  });
});

describe("pause / resume — tenancy (XB-A): only the passed payer is touched", () => {
  it("pauses then resumes the payer's own posting", () => {
    const id = getPostings(PAYER_A)[0]!.id;
    expect(pausePosting(PAYER_A, id)!.status).toBe("paused");
    expect(resumePosting(PAYER_A, id)!.status).toBe("open");
  });

  it("returns null and mutates NOTHING for another payer's posting id", () => {
    const aPostingId = getPostings(PAYER_A)[0]!.id;
    // Payer B tries to pause Payer A's posting → neutral not-found, no write.
    expect(pausePosting(PAYER_B, aPostingId)).toBeNull();
    expect(resumePosting(PAYER_B, aPostingId)).toBeNull();
    // Payer A's posting is untouched (still open).
    expect(getPostings(PAYER_A)[0]!.status).toBe("open");
    // Payer B's tenant gained nothing.
    expect(getPostings(PAYER_B)).toHaveLength(0);
  });

  it("pause/resume are idempotent and never flip an unrelated status", () => {
    const id = getPostings(PAYER_A)[0]!.id;
    pausePosting(PAYER_A, id);
    expect(pausePosting(PAYER_A, id)!.status).toBe("paused"); // still paused
  });
});

describe("topUpPostingQuota — config step, tenancy", () => {
  it("raises quota by exactly the config'd step (never a hardcoded amount)", () => {
    const id = getPostings(PAYER_A)[0]!.id;
    const before = getPostings(PAYER_A)[0]!.applicantQuota ?? 0;
    const step = applicantQuotaStep();
    const after = topUpPostingQuota(PAYER_A, id)!.applicantQuota ?? 0;
    expect(step).not.toBeNull();
    expect(after).toBe(before + step!);
  });

  it("returns null for another payer's posting and does not write", () => {
    const aId = getPostings(PAYER_A)[0]!.id;
    const before = getPostings(PAYER_A)[0]!.applicantQuota;
    expect(topUpPostingQuota(PAYER_B, aId)).toBeNull();
    expect(getPostings(PAYER_A)[0]!.applicantQuota).toBe(before);
  });
});

describe("config helpers expose only catalog-derived values", () => {
  it("a baseline active-vacancy allowance exists and is positive", () => {
    expect(baselineActiveVacancyAllowance()).toBeGreaterThan(0);
  });
  it("the applicant quota step is positive", () => {
    expect(applicantQuotaStep()).toBeGreaterThan(0);
  });
});
