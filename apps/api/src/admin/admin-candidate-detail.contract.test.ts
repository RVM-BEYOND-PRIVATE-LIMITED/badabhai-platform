import { describe, expect, it } from "vitest";
import { toCandidateRow } from "../candidates/candidate-search.service";
import { readProfileFormFacts } from "../workers/profile-form-facts";
import { toProfileSummary } from "../workers/profile-summary.mapper";
import { toCandidateDetail, type CandidateDetailInputs } from "./admin-candidate-detail.mapper";
import { candidateInputs, profileFixture, prov } from "./testing/candidate-detail-fixtures";

/**
 * THE #2560 ACCEPTANCE CONTRACT, over mocked rows: for the same worker, the admin record's city,
 * role, skills, experience and salary equal what the EMPLOYER-FACING projections produce —
 * `toProfileSummary` (built exactly as `WorkersService.getProfileSummary` builds it) and the payer
 * search's `toCandidateRow`, each computed HERE, independently, from the same raw inputs.
 *
 * The city and the salary are the load-bearing half: the admin read computes them through the
 * `...WithSource` resolvers, not through the summary, so these assertions are what holds the two
 * readings together. `admin-candidate-detail.db.test.ts` proves the same against Postgres,
 * including that the card row is the search statement's own.
 */

function summaryOf(input: CandidateDetailInputs) {
  return toProfileSummary(
    input.profile
      ? {
          ...input.profile,
          hasPhoto: input.core.hasPhoto,
          workerCity: input.core.currentCity,
          formFacts: readProfileFormFacts(input.tradeSheet),
        }
      : null,
  );
}

const base = candidateInputs();

/** A matrix of workers that exercises every precedence branch the five fields have. */
const CASES: Record<string, CandidateDetailInputs> = {
  rich: base,
  noOwnCity: { ...base, core: { ...base.core, currentCity: null } },
  blankOwnCity: { ...base, core: { ...base.core, currentCity: "   " } },
  onlyPreferredCity: {
    ...base,
    core: { ...base.core, currentCity: null },
    profile: profileFixture({ locationPreference: { preferred_cities: ["", "Nashik"] } }),
  },
  noCityAnywhere: {
    ...base,
    core: { ...base.core, currentCity: null },
    profile: profileFixture({ locationPreference: {} }),
  },
  containerSalary: {
    ...base,
    profile: profileFixture({ salaryExpectation: { amount_min: 21000, amount_max: 26000 } }),
  },
  onlyMaxSalary: {
    ...base,
    tradeSheet: { packId: null, attributes: { salary_expected_max: 30000 } },
    provenance: [prov("salary_expected_max")],
  },
  openTopChip: {
    ...base,
    tradeSheet: { packId: null, attributes: { salary_expected_max: 100_000 } },
    provenance: [prov("salary_expected_max")],
  },
  noSalary: { ...base, tradeSheet: { packId: null, attributes: {} }, provenance: [] },
  zeroYears: { ...base, profile: profileFixture({ experience: { total_years: 0 } }) },
  noYears: { ...base, profile: profileFixture({ experience: {} }) },
  skillIds: {
    ...base,
    profile: profileFixture({ skills: ["skill_mig_welding", "Free text skill"], machines: [] }),
  },
  twoWantedRoles: {
    ...base,
    card: {
      row: {
        ...base.card.row!,
        skillId: "mskill_vmc_operator",
        skillMonths: 30,
        industryMonths: null,
        currentCity: "Chakan",
      },
      wantedRoles: [
        { workerId: base.workerId, skillId: "mskill_vmc_operator", monthsBucketed: 30 },
        { workerId: base.workerId, skillId: "mskill_cnc_turner", monthsBucketed: 6 },
      ],
      tradeLevels: [
        {
          workerId: base.workerId,
          skillId: "mskill_vmc_operator",
          tradeLevel: "operator",
          levelConfirmed: true,
        },
        {
          workerId: base.workerId,
          skillId: "mskill_cnc_turner",
          tradeLevel: "setter",
          levelConfirmed: false,
        },
      ],
    },
  },
};

describe("#2560 contract — the admin record equals the employer-facing projections", () => {
  for (const [name, input] of Object.entries(CASES)) {
    it(`${name}: city, skills, machines, experience and salary match toProfileSummary`, () => {
      const d = toCandidateDetail(input);
      const summary = summaryOf(input);
      expect(d.location.current_city.value, "city").toBe(summary.city);
      expect(d.skills.skills.value, "skills").toEqual(summary.skills);
      expect(d.skills.machines.value, "machines").toEqual(summary.machines);
      expect(d.experience.total_years.value, "experience").toBe(summary.experience_years);
      expect(d.trade.display_name.value, "trade display name").toBe(summary.trade.display_name);
      // The summary scores salary as a dimension: the admin band is present exactly when it scores.
      expect(d.salary.band.value !== null, "salary").toBe(
        !summary.missing_fields.includes("salary"),
      );
    });

    it(`${name}: the employer card's role, other roles, months, industry and city match toCandidateRow`, () => {
      const d = toCandidateDetail(input);
      const row = input.card.row!;
      const card = toCandidateRow(row, false, input.card.wantedRoles, input.card.tradeLevels);
      expect(d.employer_card.role.value).toEqual(card.role);
      expect(d.employer_card.other_roles.value).toEqual(card.otherRoles);
      expect(d.employer_card.role_months.value).toBe(card.skillMonths);
      expect(d.employer_card.industry.value).toEqual(card.industry);
      expect(d.employer_card.industry_months.value).toBe(card.industryMonths);
      expect(d.employer_card.city.value).toBe(card.city);
      expect(d.employer_card.trade_levels.value).toEqual(card.tradeLevels);
      expect(d.employer_card.is_sample).toBe(card.isSample);
    });
  }

  it("#2728 — correction_values is absent (null) unless the service loaded the gated block", () => {
    // The pure mapper never invents a prefill block: the service decides whether this admin may
    // receive it, and an analyst's response is byte-identical in this group to every non-editor's.
    for (const input of Object.values(CASES)) {
      expect(toCandidateDetail(input).correction_values).toBeNull();
    }
  });

  it("the matrix really exercises the branches it names (not vacuous)", () => {
    const cities = Object.values(CASES).map((c) => summaryOf(c).city);
    expect(new Set(cities)).toEqual(new Set(["Pune", "Chakan", "Nashik", null]));
    const salaried = Object.values(CASES).filter(
      (c) => !summaryOf(c).missing_fields.includes("salary"),
    );
    expect(salaried.length).toBeGreaterThan(2);
    expect(salaried.length).toBeLessThan(Object.keys(CASES).length);
    expect(toCandidateDetail(CASES.twoWantedRoles!).employer_card.other_roles.value.length).toBe(1);
    expect(summaryOf(CASES.zeroYears!).experience_years).toBe(0);
  });
});
