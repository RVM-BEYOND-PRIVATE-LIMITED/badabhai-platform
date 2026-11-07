import { describe, expect, it } from "vitest";
import {
  EMPTY_APPLICANT_PROFILE_FACTS,
  graftLegacyApplicantFacts,
  industryBandFromMonths,
  lastActiveBandFrom,
  toApplicantProfileFacts,
  toApplicantTradeLevelBadge,
  type ApplicantProfileFactsSourceRow,
} from "./applicant-profile-facts";

/**
 * #2736 — the non-contact facts grafted onto payer applicant rows. Pure: every rule here
 * is unit-tested without a database. Unknown stays unknown (`null`); nothing is derived,
 * averaged or guessed; nothing that names, contacts or locates a person can come out,
 * because nothing like that goes in.
 */
const row = (over: Partial<ApplicantProfileFactsSourceRow> = {}): ApplicantProfileFactsSourceRow => ({
  workerId: "11111111-1111-4111-8111-111111111111",
  skillIds: null,
  totalYears: null,
  availabilityStatus: null,
  educationCredential: null,
  certificateCount: 0,
  industryMonths: null,
  tradeLevels: [],
  lastSeenAt: null,
  ...over,
});

describe("toApplicantProfileFacts", () => {
  it("maps every stored signal to its coarse display fact", () => {
    expect(
      toApplicantProfileFacts(
        row({
          skillIds: ["skill_tig_welding", "skill_arc_welding"],
          totalYears: 4,
          availabilityStatus: "within_week",
          educationCredential: "iti",
          certificateCount: 2,
          industryMonths: 30,
          tradeLevels: [{ skillId: "mskill_tig_welder", tradeLevel: "operator", levelConfirmed: true }],
          lastSeenAt: new Date("2026-11-06T10:00:00Z"),
        }),
        new Date("2026-11-06T12:00:00Z"),
      ),
    ).toEqual({
      skills: ["TIG welding", "Arc welding"],
      totalExperienceBand: "3-5 yrs",
      industryExperienceBand: "1-2 yrs",
      educationLabel: "ITI",
      certificationCount: 2,
      availabilityLabel: "Within a week",
      lastActiveBand: "today",
      tradeLevels: [
        {
          skillId: "mskill_tig_welder",
          skillLabel: "TIG Welder",
          tradeLevel: "operator",
          tradeLevelLabel: "Operator",
          levelConfirmed: true,
        },
      ],
    });
  });

  it("caps the skill list and drops blanks; an all-blank list is null, not []", () => {
    const many = Array.from({ length: 20 }, (_, i) => `skill_x_${i}`);
    const facts = toApplicantProfileFacts(row({ skillIds: [...many, "  ", 42] }));
    expect(facts.skills).toHaveLength(8);
    expect(toApplicantProfileFacts(row({ skillIds: ["  ", 42, null] })).skills).toBeNull();
    expect(toApplicantProfileFacts(row({ skillIds: null })).skills).toBeNull();
  });

  it("an unknown credential slug or availability status renders null, never raw", () => {
    const facts = toApplicantProfileFacts(row({ educationCredential: "phd_oxford", availabilityStatus: "someday" }));
    expect(facts.educationLabel).toBeNull();
    expect(facts.availabilityLabel).toBeNull();
  });

  it("an empty stored row maps to the all-empty facts, with a zero certificate count", () => {
    expect(toApplicantProfileFacts(row())).toEqual({
      ...EMPTY_APPLICANT_PROFILE_FACTS,
      certificationCount: 0,
    });
  });
});

describe("lastActiveBandFrom", () => {
  const now = new Date("2026-11-06T12:00:00Z");
  it.each([
    ["2026-11-06T11:00:00Z", "today"],
    ["2026-11-05T12:00:00Z", "this week"],
    ["2026-10-20T12:00:00Z", "this month"],
    ["2026-01-01T00:00:00Z", "earlier"],
  ])("%s → %s", (seen, band) => {
    expect(lastActiveBandFrom(new Date(seen), now)).toBe(band);
  });

  it("a future timestamp reads as the most recent bucket, never vanishes", () => {
    expect(lastActiveBandFrom(new Date("2026-11-07T00:00:00Z"), now)).toBe("today");
  });

  it("null and garbage are unknown", () => {
    expect(lastActiveBandFrom(null, now)).toBeNull();
    expect(lastActiveBandFrom("not-a-date", now)).toBeNull();
  });
});

describe("industryBandFromMonths", () => {
  it("bands whole years down like the total band", () => {
    expect(industryBandFromMonths(30)).toBe("1-2 yrs");
    expect(industryBandFromMonths(0)).toBe("<1 yr");
  });

  it("negative, NaN and null are unknown — never a band", () => {
    expect(industryBandFromMonths(null)).toBeNull();
    expect(industryBandFromMonths(-3)).toBeNull();
    expect(industryBandFromMonths(Number.NaN)).toBeNull();
  });
});

describe("toApplicantTradeLevelBadge", () => {
  it("resolves both labels server-side; an unknown rung prints its own key", () => {
    expect(
      toApplicantTradeLevelBadge({ skillId: "mskill_tig_welder", tradeLevel: "setter", levelConfirmed: false }),
    ).toEqual({
      skillId: "mskill_tig_welder",
      skillLabel: "TIG Welder",
      tradeLevel: "setter",
      tradeLevelLabel: "Setter",
      levelConfirmed: false,
    });
    expect(
      toApplicantTradeLevelBadge({ skillId: "skill_x", tradeLevel: "wizard", levelConfirmed: true }),
    ).toEqual({
      skillId: "skill_x",
      skillLabel: null,
      tradeLevel: "wizard",
      tradeLevelLabel: "wizard",
      levelConfirmed: true,
    });
  });
});

describe("graftLegacyApplicantFacts", () => {
  it("grafts every legacy fact but never a second total-experience band", () => {
    const rows = [{ workerId: "w1", rank: 1 }, { workerId: "w2", rank: 2 }];
    const out = graftLegacyApplicantFacts(
      rows,
      new Map([
        ["w1", { ...EMPTY_APPLICANT_PROFILE_FACTS, skills: ["TIG Welding"], totalExperienceBand: "3-5 yrs", tradeLevels: [] }],
      ]),
    );
    expect(out[0]).toMatchObject({ workerId: "w1", skills: ["TIG Welding"] });
    expect(out[0]).not.toHaveProperty("totalExperienceBand");
    expect(out[1]).toEqual({
      workerId: "w2",
      rank: 2,
      skills: null,
      industryExperienceBand: null,
      educationLabel: null,
      certificationCount: null,
      availabilityLabel: null,
      lastActiveBand: null,
      tradeLevels: [],
    });
    expect(out).toHaveLength(2);
  });
});
