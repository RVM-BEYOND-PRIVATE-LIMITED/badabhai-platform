import { isSampleWorkerId, type WorkerProfile } from "@badabhai/db";
import { getRole, INDUSTRIES, matchSkillLabel } from "@badabhai/taxonomy";
import { toCandidateRow } from "../candidates/candidate-search.service";
import type { CandidateTradeLevelRow } from "../candidates/candidate-search.service";
import type { CandidatePoolRow, CandidateRoleRow } from "../candidates/candidate-search.repository";
import {
  combineSources,
  isOpenTopSalaryChip,
  resolveAvailabilityStateWithSource,
  resolveCityForSummaryWithSource,
  resolveSalaryBand,
  resolveSalaryBandWithSource,
  resolveSalaryPeriodWithSource,
  resolveWorkTypesWithSource,
  type FieldSource,
} from "../profiles/worker-field-precedence";
import {
  AVAILABILITY_STATUSES,
  JOB_TYPES,
  WORK_TYPES,
  labelFor,
  labelsFor,
} from "../profiles/worker-preferences.vocabulary";
import { readPreferenceFacts } from "../resume/resume-preference-facts";
import {
  qualificationFactsFrom,
  type WorkerCertificateRecord,
  type WorkerEducationRecord,
  type WorkerLanguageRecord,
  type WorkerTrainingRecord,
} from "../resume/resume-qualification-rows";
import {
  attributeSourceOf,
  jobDomainSourceOf,
  profileRowSource,
  workerSkillSourceOf,
  type AttributeProvenance,
} from "../workers/profile-field-sources";
import { readProfileFormFacts } from "../workers/profile-form-facts";
import { toProfileSummary } from "../workers/profile-summary.mapper";
import type { AdminApplicationListItem } from "./admin-entities.dto";
import type { AdminCandidateDetail, AdminCandidateField } from "./admin-candidate-detail.dto";
import type {
  CandidateAccountRow,
  CandidateCoreRow,
  CandidateEmploymentRow,
  CandidateJobDomainRow,
  CandidateMatchSkillRow,
  CandidateResumeVersionRow,
  CandidateTenureRow,
} from "./admin-candidate-detail.repository";

/**
 * PURE: everything one candidate read loaded → the `GET /admin/candidates/:id` response
 * (ADR-0062, #2560). No I/O, no clock, no DI.
 *
 * EVERY VALUE IS COMPUTED BY THE CODE THE EMPLOYER-FACING READS RUN, never restated here:
 *   - `toProfileSummary` (exactly as `WorkersService.getProfileSummary` calls it) for the trade,
 *     the skills and machines, total years and the education labels;
 *   - `toCandidateRow` over the payer search's own row for the employer card;
 *   - `readPreferenceFacts` / `qualificationFactsFrom` for what the résumé prints from the
 *     attribute bag and the credential rows;
 *   - the `...WithSource` resolvers in `worker-field-precedence.ts`, which call the existing
 *     resolvers, for the city, the salary band and period, availability and work types.
 * This file only arranges those values into groups and attaches each one's source (through the
 * pure helpers in `profile-field-sources.ts`). `correction` is null everywhere until #2561.
 */

/** Everything the service loaded for one worker. */
export interface CandidateDetailInputs {
  readonly workerId: string;
  /**
   * #2561 — the worker's LIVE admin corrections (ADR-0062 §3.2 point 1). The corrected values
   * are applied above the store precedence, and their metadata fills the per-field `correction`.
   * Absent for callers that predate the correction layer.
   */
  readonly corrections?: readonly {
    readonly id: string;
    readonly factKey: string;
    readonly adminId: string;
    readonly reasonCode: string;
    readonly createdAt: Date;
    readonly corrected: unknown;
  }[];
  readonly core: CandidateCoreRow;
  /** `disclosed` = the identity layer returned names to this admin on this response. */
  readonly name: { readonly disclosed: boolean; readonly value: string | null };
  readonly profile: WorkerProfile | undefined;
  readonly jobDomain: CandidateJobDomainRow | null;
  readonly tradeSheet: {
    readonly packId: string | null;
    readonly attributes: Readonly<Record<string, unknown>>;
  };
  readonly provenance: readonly AttributeProvenance[];
  readonly qualifications: {
    readonly certificates: readonly WorkerCertificateRecord[];
    readonly educations: readonly WorkerEducationRecord[];
    readonly trainings: readonly WorkerTrainingRecord[];
  };
  readonly languages: readonly WorkerLanguageRecord[];
  readonly occupations: readonly string[];
  readonly employment: readonly CandidateEmploymentRow[];
  readonly matchSkills: readonly CandidateMatchSkillRow[];
  readonly tenure: readonly CandidateTenureRow[];
  readonly card: {
    readonly row: CandidatePoolRow | null;
    readonly wantedRoles: readonly CandidateRoleRow[];
    readonly tradeLevels: readonly CandidateTradeLevelRow[];
  };
  readonly resumes: { readonly rows: readonly CandidateResumeVersionRow[]; readonly total: number };
  readonly account: CandidateAccountRow;
  readonly recentApplications: readonly AdminApplicationListItem[];
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function scalar(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function iso(value: Date): string {
  return value.toISOString();
}

function isoOrNull(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** A value with nothing in it has no source, whatever writer the caller names. */
function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** One field. `correction` is the #2561 seam — null until the correction layer exists. */
export function fieldOf<T>(value: T, source: FieldSource): AdminCandidateField<T> {
  return { value, source: isEmpty(value) ? "none" : source, correction: null };
}

function industryLabelled(industryId: string): { id: string; label: string } {
  return { id: industryId, label: INDUSTRIES.find((i) => i.id === industryId)?.name ?? industryId };
}

/** The legacy (extraction) availability status, tolerating a bare string like the summary does. */
function legacyAvailabilityStatus(availability: unknown): string | null {
  if (typeof availability === "string") return scalar(availability);
  return scalar(asObject(availability)?.status);
}

export function toCandidateDetail(input: CandidateDetailInputs): AdminCandidateDetail {
  const { core, profile } = input;
  const attributes = input.tradeSheet.attributes;
  const correctionOf = (factKey: string) =>
    input.corrections?.find((c) => c.factKey === factKey);
  const correctedValue = (factKey: string): unknown => correctionOf(factKey)?.corrected;
  const correctionMeta = (factKey: string) => {
    const live = correctionOf(factKey);
    return live === undefined
      ? null
      : {
          override_id: live.id,
          admin_id: live.adminId,
          reason_code: live.reasonCode,
          created_at: live.createdAt.toISOString(),
        };
  };
  const provenance = new Map(input.provenance.map((p) => [p.attributeKey, p]));
  const attr = (key: string): FieldSource => attributeSourceOf(provenance.get(key));
  const profileSource = profileRowSource(profile);

  // The worker's self-view summary, built exactly as `WorkersService.getProfileSummary` builds it.
  const summary = toProfileSummary(
    profile
      ? {
          ...profile,
          hasPhoto: core.hasPhoto,
          workerCity: core.currentCity,
          formFacts: readProfileFormFacts(input.tradeSheet),
        }
      : null,
  );
  const prefs = readPreferenceFacts(attributes);
  const qualifications = qualificationFactsFrom({
    ...input.qualifications,
    languages: input.languages,
  });
  const location = asObject(profile?.locationPreference);
  const salaryContainer = asObject(profile?.salaryExpectation);
  const container = {
    amountMin: finiteNumber(salaryContainer?.amount_min),
    amountMax: finiteNumber(salaryContainer?.amount_max),
  };
  const attributeBand = { expected: prefs.salaryMin, expectedMax: prefs.salaryMax };

  const cityOverride = correctedValue("current_city");
  const city =
    typeof cityOverride === "string"
      ? { value: cityOverride, source: "admin_override" as const }
      : resolveCityForSummaryWithSource(
          {
            workersColumn: core.currentCity,
            profileCurrentCity: scalar(location?.current_city),
            profilePreferredCities: stringList(location?.preferred_cities),
          },
          { workersColumn: "worker_edit", profile: profileSource },
        );
  const preferredLocationsOverride = correctedValue("preferred_locations");
  const preferredLocations = Array.isArray(preferredLocationsOverride)
    ? (preferredLocationsOverride.filter((v): v is string => typeof v === "string") ?? [])
    : prefs.preferredLocations;
  const band = resolveSalaryBandWithSource({
    container,
    containerSource: profileSource,
    attributes: attributeBand,
    attributeSources: {
      expected: attr("salary_expected_min"),
      expectedMax: attr("salary_expected_max"),
    },
  });
  const period = resolveSalaryPeriodWithSource(
    scalar(attributes.salary_period),
    attr("salary_period"),
  );
  const availability = resolveAvailabilityStateWithSource(
    {
      workerAnswer: asObject(attributes.availability),
      legacyStatus: legacyAvailabilityStatus(profile?.availability),
    },
    { workerAnswer: attr("availability"), legacy: profileSource },
  );
  const workTypes = resolveWorkTypesWithSource(
    stringList(attributes.work_types),
    scalar(attributes.job_type),
    { workTypes: attr("work_types"), jobType: attr("job_type") },
  );
  const languageRows = qualifications?.languages;

  return {
    worker_id: input.workerId,
    identity: {
      // `unknown` even when disclosed: `WorkersService.setFullName` has worker-route AND ops-route
      // callers and the column records neither.
      name: {
        value: input.name.disclosed ? input.name.value : null,
        source: input.name.disclosed && input.name.value === null ? "none" : "unknown",
        correction: null,
      },
      name_disclosed: input.name.disclosed,
      // Only the worker can upload a photo.
      has_photo: {
        value: core.hasPhoto,
        source: core.hasPhoto ? "worker_edit" : "none",
        correction: null,
      },
      // NOT NULL DEFAULT true: a worker who never touched it and one who chose "show" look the same.
      resume_show_photo: { value: core.resumeShowPhoto, source: "unknown", correction: null },
      preferred_language: fieldOf(core.preferredLanguage, "unknown"),
    },
    location: {
      current_city: {
        ...fieldOf(city.value, city.source),
        correction: correctionMeta("current_city"),
      },
      // Written only by `WorkersService.setLocation` (onboarding screen / identity intake).
      current_state: fieldOf(core.currentState, "worker_edit"),
      preferred_locations: {
        ...fieldOf(preferredLocations, attr("preferred_locations")),
        correction: correctionMeta("preferred_locations"),
      },
    },
    trade: {
      canonical_trade_id: fieldOf(summary.trade.canonical_trade_id, profileSource),
      canonical_role_id: fieldOf(summary.trade.canonical_role_id, profileSource),
      display_name: fieldOf(summary.trade.display_name, profileSource),
      job_domain: fieldOf(
        input.jobDomain?.jobDomainId
          ? {
              id: input.jobDomain.jobDomainId,
              label: input.jobDomain.label ?? input.jobDomain.jobDomainId,
            }
          : null,
        jobDomainSourceOf(input.jobDomain?.matchStatus),
      ),
      // `worker_occupation` is written by the worker's own page/chat edit AND, when empty, by the
      // interview's insert-only fallback (`ChatTableWritesService`) — no column says which.
      secondary_roles: fieldOf(
        input.occupations.map((id) => ({ id, label: getRole(id)?.name ?? id })),
        "unknown",
      ),
    },
    employer_card: employerCard(input),
    skills: {
      skills: fieldOf(summary.skills, profileSource),
      machines: fieldOf(summary.machines, profileSource),
      match_skills: input.matchSkills.map((s) => ({
        skill_id: s.skillId,
        label: matchSkillLabel(s.skillId) ?? s.skillId,
        industry: industryLabelled(s.industryId),
        months_bucketed: s.monthsBucketed,
        wants: s.wants,
        source: workerSkillSourceOf(s.source),
      })),
    },
    experience: {
      total_years: fieldOf(summary.experience_years, profileSource),
      industry_tenure: fieldOf(
        input.tenure.map((t) => ({
          industry: industryLabelled(t.industryId),
          calendar_months: t.calendarMonths,
        })),
        "derived",
      ),
    },
    // Written only by `WorkerEmploymentService.replaceForWorker` (the worker's page, a confirmed
    // chat edit). The employer name is not on this surface (encrypted at rest).
    work_history: fieldOf(
      input.employment.map((e) => ({
        employer_city: e.employerCity,
        employer_state: e.employerState,
        start_ym: e.startYm,
        end_ym: e.endYm,
        duration_stated: e.durationStated,
        roles: e.roles.map((r) => ({
          role_label: r.roleLabel,
          start_ym: r.startYm,
          end_ym: r.endYm,
          work_done: r.workDone,
          work_done_polished: r.workDonePolished,
          work_done_polish_declined: r.workDonePolishDeclined,
        })),
      })),
      "worker_edit",
    ),
    education: {
      // Education and certificate rows: the worker's qualifications page, a confirmed chat edit,
      // or his own extracted-field correction — all `WorkerQualificationsService`.
      headline: fieldOf(qualifications?.educationHeadline ?? null, "worker_edit"),
      education: fieldOf(qualifications?.education ?? [], "worker_edit"),
      certifications: fieldOf(qualifications?.certifications ?? [], "worker_edit"),
      // Training rows also arrive from the interview's insert-only fallback — no column says which.
      training: fieldOf(qualifications?.trainings ?? [], "unknown"),
      education_level: fieldOf(summary.education_level, profileSource),
      education_field: fieldOf(summary.education_field, profileSource),
      education_detail: fieldOf(
        prefs.educationDetail,
        combineSources([
          attr("education_council"),
          attr("education_year"),
          attr("education_institute"),
        ]),
      ),
      education_credential: fieldOf(prefs.educationCredential, attr("education_credential")),
    },
    // The résumé's rule: the language rows' lines win, else the `languages` attribute.
    languages:
      languageRows !== undefined
        ? fieldOf(languageRows, "worker_edit")
        : fieldOf(prefs.languages, attr("languages")),
    salary: {
      band: fieldOf(band.value, band.source),
      period: { value: period.value, source: period.source, correction: null },
      // The chip is an ATTRIBUTE answer; a container figure outranks the attributes outright.
      open_top_chip:
        resolveSalaryBand({ expected: container.amountMin, expectedMax: container.amountMax }) ===
          null && isOpenTopSalaryChip(attributeBand),
    },
    preferences: {
      availability: {
        value: {
          status: availability.value.status,
          status_label: labelFor(AVAILABILITY_STATUSES, availability.value.status ?? ""),
          available_from: availability.value.availableFrom,
          notice_period_days: availability.value.noticePeriodDays,
        },
        source: availability.source,
        correction: null,
      },
      shift: fieldOf(prefs.shiftLabel, attr("shift_preference")),
      // The worker's toggle, or seeded from his shift answer (`seedNightShiftReadyFromShift`).
      night_shift_ready: fieldOf(core.resumeNightShiftReady, "unknown"),
      relocation: fieldOf(prefs.willingToRelocate ?? null, attr("relocation_willingness")),
      accommodation: fieldOf(prefs.accommodationNeeded ?? null, attr("accommodation_needed")),
      job_type: fieldOf(labelFor(JOB_TYPES, scalar(attributes.job_type) ?? ""), attr("job_type")),
      work_types: fieldOf(labelsFor(WORK_TYPES, workTypes.value), workTypes.source),
      commute_max_km: fieldOf(prefs.commuteMaxKm, attr("commute_max_km")),
      willing_to_travel: fieldOf(prefs.willingToTravel ?? null, attr("willing_to_travel")),
      documents: fieldOf(prefs.documents, attr("documents_ready")),
    },
    resume: {
      versions: input.resumes.rows.map((r) => ({
        resume_id: r.id,
        version: r.version,
        generation_trigger: r.generationTrigger,
        generation_source: r.generationSource,
        render_status: r.renderStatus,
        template_id: r.templateId,
        has_pdf: r.hasPdf,
        generated_at: iso(r.generatedAt),
        rendered_at: isoOrNull(r.renderedAt),
      })),
      version_count: input.resumes.total,
      truncated: input.resumes.total > input.resumes.rows.length,
    },
    account: account(input, summary, profileSource),
    activity: {
      application_count: input.account.appliedCount,
      skipped_count: input.account.skippedCount,
      recent_applications: input.recentApplications.map((a) => ({
        id: a.id,
        job_id: a.job_id,
        job_posting_id: a.job_posting_id,
        source_surface: a.source_surface,
        match_tier: a.match_tier,
        created_at: iso(a.created_at),
      })),
      unlock_count: input.account.unlockCount,
    },
  };
}

/**
 * The payer all-candidates search card, through `toCandidateRow` over the search's own row (no
 * filter engaged, so `roleFiltered` is false exactly as an unfiltered search runs it). Not in the
 * pool → every value empty: an employer does not see this worker at all.
 */
function employerCard(input: CandidateDetailInputs): AdminCandidateDetail["employer_card"] {
  const row = input.card.row;
  if (row === null) {
    return {
      in_search_pool: false,
      is_sample: isSampleWorkerId(input.workerId),
      role: fieldOf(null, "none"),
      other_roles: fieldOf([], "none"),
      role_months: fieldOf(null, "none"),
      industry: fieldOf(null, "none"),
      industry_months: fieldOf(null, "none"),
      city: fieldOf(null, "none"),
      trade_levels: fieldOf([], "none"),
    };
  }
  const card = toCandidateRow(row, false, input.card.wantedRoles, input.card.tradeLevels);
  return {
    in_search_pool: true,
    is_sample: card.isSample,
    // The lead role, its months and its industry are the match derivation's.
    role: fieldOf(card.role, "derived"),
    other_roles: fieldOf(card.otherRoles, "derived"),
    role_months: fieldOf(card.skillMonths, "derived"),
    industry: fieldOf(card.industry, "derived"),
    industry_months: fieldOf(card.industryMonths, "derived"),
    // `workers.current_city`, canonicalised — the worker's own answer.
    city: fieldOf(card.city, "worker_edit"),
    // A stated rung from whichever profile last stated it; the road is not recorded on the rung.
    trade_levels: fieldOf(card.tradeLevels, "unknown"),
  };
}

function account(
  input: CandidateDetailInputs,
  summary: ReturnType<typeof toProfileSummary>,
  profileSource: FieldSource,
): AdminCandidateDetail["account"] {
  const { core } = input;
  const consent = input.account.consent;
  return {
    status: core.status,
    verification_state: core.verificationState,
    verified_at: isoOrNull(core.verifiedAt),
    is_test_account: core.isTestAccount,
    is_sample: isSampleWorkerId(input.workerId),
    deletion_scheduled_at: isoOrNull(core.deletionScheduledAt),
    created_at: iso(core.createdAt),
    updated_at: iso(core.updatedAt),
    profile: {
      status: summary.profile_status,
      source: profileSource,
      confirmed_at: summary.confirmed_at,
      form_level: input.account.formLevel,
    },
    consent: {
      state: consent === null ? "none" : consent.revokedAt === null ? "active" : "revoked",
      consent_version: consent?.consentVersion ?? null,
      accepted_at: isoOrNull(consent?.acceptedAt),
      purposes: consent?.purposes ?? [],
      employer_sharing:
        consent !== null &&
        consent.revokedAt === null &&
        consent.purposes.includes("employer_sharing"),
    },
    devices: {
      count: input.account.deviceCount,
      latest_app_version: input.account.latestAppVersion,
      last_seen_at: isoOrNull(input.account.lastSeenAt),
    },
    flag: {
      flagged: input.account.flag !== null,
      reason_code: input.account.flag?.reasonCode ?? null,
      flagged_at: isoOrNull(input.account.flag?.flaggedAt),
    },
  };
}
