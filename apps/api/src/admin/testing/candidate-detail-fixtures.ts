import type { WorkerProfile } from "@badabhai/db";
import type { CandidateDetailInputs } from "../admin-candidate-detail.mapper";
import type { AttributeProvenance } from "../../workers/profile-field-sources";

/**
 * TEST SUPPORT — one fully-loaded candidate for the #2560 mapper/service/contract tests. Synthetic
 * values only (no real person, no phone). `over` replaces whole top-level inputs.
 */
export const FIXTURE_WORKER_ID = "0b7f1a52-4a0e-4c41-9d61-2f1f3c1e9a01";
export const FIXTURE_ADMIN_ID = "a1a1a1a1-0000-4000-8000-000000000001";

const AT = new Date("2026-11-01T10:00:00.000Z");

export function profileFixture(over: Partial<WorkerProfile> = {}): WorkerProfile {
  return {
    id: "c0c0c0c0-0000-4000-8000-000000000001",
    workerId: FIXTURE_WORKER_ID,
    aiJobId: null,
    profileStatus: "confirmed",
    source: "chat",
    canonicalTradeId: null,
    canonicalRoleId: null,
    skills: ["MIG Welding", "Arc Welding"],
    taxonomyVersion: null,
    machines: ["VMC"],
    experience: { total_years: 4, summary: "free text never projected" },
    salaryExpectation: {},
    locationPreference: { current_city: "Chakan", preferred_cities: ["Pune"] },
    availability: { status: "immediate" },
    rawProfile: { role_label: "Welder", education_level: "iti", education_field: "Welder" },
    richProfileDraft: null,
    embedding: null,
    jobDomainId: null,
    jobDomainMatchStatus: null,
    jobDomainMatchScore: null,
    jobDomainMatchLayer: null,
    jobDomainMatchedAt: null,
    seededFromImportId: null,
    resumeUpdateAcceptedAt: null,
    confirmedAt: AT,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  } as WorkerProfile;
}

export const prov = (
  attributeKey: string,
  over: Partial<AttributeProvenance> = {},
): AttributeProvenance => ({
  attributeKey,
  valueSource: "answer_map",
  hasPack: false,
  hasSession: false,
  answerSource: null,
  ...over,
});

export function candidateInputs(over: Partial<CandidateDetailInputs> = {}): CandidateDetailInputs {
  return {
    workerId: FIXTURE_WORKER_ID,
    core: {
      id: FIXTURE_WORKER_ID,
      status: "active",
      preferredLanguage: "hi",
      hasPhoto: true,
      resumeShowPhoto: true,
      resumeNightShiftReady: null,
      currentCity: "Pune",
      currentState: "Maharashtra",
      verificationState: null,
      verifiedAt: null,
      isTestAccount: false,
      deletionScheduledAt: null,
      createdAt: AT,
      updatedAt: AT,
    },
    name: { disclosed: true, value: "Test Worker" },
    profile: profileFixture(),
    jobDomain: { jobDomainId: "jd_welder", label: "Welder", matchStatus: "matched_auto" },
    tradeSheet: {
      packId: null,
      attributes: {
        preferred_locations: ["Pune", "Chakan"],
        shift_preference: "night",
        job_type: "permanent",
        work_types: ["contract"],
        salary_expected_min: 18000,
        salary_expected_max: 22000,
        salary_period: "month",
        relocation_willingness: true,
        accommodation_needed: false,
        commute_max_km: 0,
        willing_to_travel: true,
        documents_ready: ["aadhaar", "pan"],
        languages: ["hindi", "marathi"],
        availability: { status: "within_week" },
      },
    },
    provenance: [
      prov("preferred_locations"),
      prov("shift_preference", { hasPack: true, hasSession: true, answerSource: "chat" }),
      prov("job_type", { hasPack: true, hasSession: true, answerSource: "form" }),
      prov("work_types"),
      prov("salary_expected_min"),
      prov("salary_expected_max"),
      prov("salary_period"),
      prov("relocation_willingness"),
      prov("accommodation_needed"),
      prov("commute_max_km"),
      prov("willing_to_travel"),
      prov("documents_ready", { hasPack: true, answerSource: "resume" }),
      prov("languages", { hasPack: true, hasSession: true, valueSource: "llm_parse" }),
      prov("availability"),
    ],
    qualifications: { certificates: [], educations: [], trainings: [] },
    languages: [],
    occupations: [],
    employment: [
      {
        employerCity: "Pune",
        employerState: "Maharashtra",
        startYm: "2021-04",
        endYm: null,
        durationStated: true,
        roles: [
          {
            roleLabel: "Welder",
            startYm: "2021-04",
            endYm: null,
            workDone: "MIG welding of frames",
            workDonePolished: null,
            workDonePolishDeclined: false,
          },
        ],
      },
    ],
    matchSkills: [
      {
        skillId: "mskill_tig_welder",
        industryId: "ind_industrial_manufacturing",
        monthsBucketed: 48,
        wants: true,
        source: "derived_coarse",
      },
      {
        skillId: "mskill_cnc_turner",
        industryId: "ind_industrial_manufacturing",
        monthsBucketed: 12,
        wants: false,
        source: "interview",
      },
    ],
    tenure: [{ industryId: "ind_industrial_manufacturing", calendarMonths: 50 }],
    card: {
      row: {
        workerId: FIXTURE_WORKER_ID,
        matched: true,
        matchClass: 1,
        skillId: "mskill_tig_welder",
        industryId: "ind_industrial_manufacturing",
        skillMonths: 48,
        industryMonths: 48,
        currentCity: "pune ",
        position: 1,
      },
      wantedRoles: [
        { workerId: FIXTURE_WORKER_ID, skillId: "mskill_tig_welder", monthsBucketed: 48 },
      ],
      tradeLevels: [],
    },
    resumes: {
      rows: [
        {
          id: "d0d0d0d0-0000-4000-8000-000000000002",
          version: 2,
          generationTrigger: "chat_edit",
          generationSource: "chat",
          renderStatus: "rendered",
          templateId: "bb_trade",
          hasPdf: true,
          generatedAt: AT,
          renderedAt: AT,
        },
      ],
      total: 1,
    },
    account: {
      deviceCount: 1,
      latestAppVersion: "1.4.2",
      lastSeenAt: AT,
      appliedCount: 3,
      skippedCount: 5,
      unlockCount: 2,
      consent: {
        consentVersion: "2026-11-04",
        purposes: ["profiling", "resume_generation", "employer_sharing"],
        acceptedAt: AT,
        revokedAt: null,
      },
      flag: null,
      formLevel: "medium",
    },
    recentApplications: [],
    ...over,
  };
}
