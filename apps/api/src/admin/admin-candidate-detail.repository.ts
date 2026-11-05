import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  applications,
  CURRENT_PROFILE_ORDER,
  generatedResumes,
  jobDomains,
  unlocks,
  workerAttributes,
  workerConsents,
  workerDevices,
  workerEmployment,
  workerEmploymentRole,
  workerFlags,
  workerIndustryTenure,
  workerPackAnswers,
  workerProfiles,
  workerProfilingTiers,
  workers,
  workerSkills,
  type Database,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import type { AttributeProvenance } from "../workers/profile-field-sources";

/** The `workers` columns the candidate read shows — faceless (no name, phone, WhatsApp, photo key). */
export interface CandidateCoreRow {
  id: string;
  status: string;
  preferredLanguage: string | null;
  hasPhoto: boolean;
  resumeShowPhoto: boolean;
  resumeNightShiftReady: boolean | null;
  currentCity: string | null;
  currentState: string | null;
  verificationState: string | null;
  verifiedAt: Date | null;
  isTestAccount: boolean;
  deletionScheduledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CandidateJobDomainRow {
  jobDomainId: string | null;
  label: string | null;
  matchStatus: string | null;
}

export interface CandidateEmploymentRow {
  employerCity: string | null;
  employerState: string | null;
  startYm: string | null;
  endYm: string | null;
  durationStated: boolean;
  roles: {
    roleLabel: string;
    startYm: string | null;
    endYm: string | null;
    workDone: string | null;
    workDonePolished: string | null;
    workDonePolishDeclined: boolean;
  }[];
}

export interface CandidateMatchSkillRow {
  skillId: string;
  industryId: string;
  monthsBucketed: number;
  wants: boolean;
  source: string;
}

export interface CandidateTenureRow {
  industryId: string;
  calendarMonths: number;
}

export interface CandidateResumeVersionRow {
  id: string;
  version: number;
  generationTrigger: string | null;
  generationSource: string | null;
  renderStatus: string;
  templateId: string;
  hasPdf: boolean;
  generatedAt: Date;
  renderedAt: Date | null;
}

export interface CandidateAccountRow {
  deviceCount: number;
  latestAppVersion: string | null;
  lastSeenAt: Date | null;
  appliedCount: number;
  skippedCount: number;
  unlockCount: number;
  consent: {
    consentVersion: string;
    purposes: string[];
    acceptedAt: Date;
    revokedAt: Date | null;
  } | null;
  flag: { reasonCode: string; flaggedAt: Date } | null;
  formLevel: string | null;
}

/**
 * DB reads for `GET /admin/candidates/:id` (ADR-0062, #2560). SELECT-ONLY, every projection
 * explicit. It reads only what no existing repository already reads for this worker — the faceless
 * worker core, the provenance columns, the résumé history rows, the account aggregates, the
 * faceless work history and the match derivation's rows with their source. Everything the
 * employer-facing reads already read (the profile row, the attribute bag, credentials, languages,
 * occupations, the search card, stated rungs) is read through THEIR repositories, by the service.
 *
 * NEVER PROJECTED, and pinned by `admin-static-guards.test.ts`: `workers.full_name` (names come
 * only from `AdminIdentityRepository`), `phone_e164` / `phone_hash` / `whatsapp_enc`,
 * `photo_storage_key` (reduced to a boolean in Postgres), `employer_name_enc`,
 * `licence_number_enc`, `pdf_storage_key` (a boolean), push tokens, device hashes and every
 * answer VALUE column on `worker_pack_answer` / `worker_attributes`.
 *
 * NO BUSINESS LOGIC: which source a row means is decided by the service through the pure helpers
 * in `profile-field-sources.ts`; this file returns the raw columns.
 */
@Injectable()
export class AdminCandidateDetailRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The worker core, or undefined when no such worker exists (the 404). */
  async findCore(workerId: string): Promise<CandidateCoreRow | undefined> {
    const rows = await this.db
      .select({
        id: workers.id,
        status: workers.status,
        preferredLanguage: workers.preferredLanguage,
        // Reduced to a boolean IN POSTGRES, so the photo's object key never enters this process.
        hasPhoto: sql<boolean>`${workers.photoStorageKey} IS NOT NULL`,
        resumeShowPhoto: workers.resumeShowPhoto,
        resumeNightShiftReady: workers.resumeNightShiftReady,
        currentCity: workers.currentCity,
        currentState: workers.currentState,
        verificationState: workers.verificationState,
        verifiedAt: workers.verifiedAt,
        isTestAccount: workers.isTestAccount,
        deletionScheduledAt: workers.deletionScheduledAt,
        createdAt: workers.createdAt,
        updatedAt: workers.updatedAt,
      })
      .from(workers)
      .where(eq(workers.id, workerId))
      .limit(1);
    return rows[0];
  }

  /** The CURRENT profile's occupation match (id, label, status), by `CURRENT_PROFILE_ORDER`. */
  async currentJobDomain(workerId: string): Promise<CandidateJobDomainRow | null> {
    const rows = await this.db
      .select({
        jobDomainId: workerProfiles.jobDomainId,
        label: jobDomains.labelEn,
        matchStatus: workerProfiles.jobDomainMatchStatus,
      })
      .from(workerProfiles)
      .leftJoin(jobDomains, eq(jobDomains.jobDomainId, workerProfiles.jobDomainId))
      .where(eq(workerProfiles.workerId, workerId))
      .orderBy(...CURRENT_PROFILE_ORDER)
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Provenance of every attribute row — NO value column. The pack answer each was projected from
   * is matched on `wpa_worker_question_uq` `(worker_id, pack_id, question_key)`; only its
   * `source` is read.
   */
  async attributeProvenance(workerId: string): Promise<AttributeProvenance[]> {
    return this.db
      .select({
        attributeKey: workerAttributes.attributeKey,
        valueSource: workerAttributes.source,
        hasPack: sql<boolean>`${workerAttributes.packId} IS NOT NULL`,
        hasSession: sql<boolean>`${workerAttributes.sessionId} IS NOT NULL`,
        answerSource: workerPackAnswers.source,
      })
      .from(workerAttributes)
      .leftJoin(
        workerPackAnswers,
        and(
          eq(workerPackAnswers.workerId, workerAttributes.workerId),
          eq(workerPackAnswers.packId, workerAttributes.packId),
          eq(workerPackAnswers.questionKey, workerAttributes.questionKey),
        ),
      )
      .where(eq(workerAttributes.workerId, workerId));
  }

  /**
   * Work history WITHOUT the employer name (encrypted at rest; not decrypted on this surface).
   * Two statements — the rows, then their roles — never one per employment.
   */
  async employment(workerId: string): Promise<CandidateEmploymentRow[]> {
    const rows = await this.db
      .select({
        id: workerEmployment.id,
        employerCity: workerEmployment.employerCity,
        employerState: workerEmployment.employerState,
        startYm: workerEmployment.startYm,
        endYm: workerEmployment.endYm,
        durationStated: workerEmployment.durationStated,
      })
      .from(workerEmployment)
      .where(eq(workerEmployment.workerId, workerId))
      .orderBy(asc(workerEmployment.sortOrder));
    if (rows.length === 0) return [];

    const roles = await this.db
      .select({
        employmentId: workerEmploymentRole.employmentId,
        roleLabel: workerEmploymentRole.roleLabel,
        startYm: workerEmploymentRole.startYm,
        endYm: workerEmploymentRole.endYm,
        workDone: workerEmploymentRole.workDone,
        workDonePolished: workerEmploymentRole.workDonePolished,
        workDonePolishDeclined: workerEmploymentRole.workDonePolishDeclined,
      })
      .from(workerEmploymentRole)
      .where(
        inArray(
          workerEmploymentRole.employmentId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(asc(workerEmploymentRole.sortOrder));

    const byEmployment = new Map<string, CandidateEmploymentRow["roles"]>();
    for (const { employmentId, ...role } of roles) {
      const bucket = byEmployment.get(employmentId) ?? [];
      bucket.push(role);
      byEmployment.set(employmentId, bucket);
    }
    return rows.map(({ id, ...row }) => ({ ...row, roles: byEmployment.get(id) ?? [] }));
  }

  /** The match derivation's skill rows, most months first (the search's own lead order). */
  async matchSkills(workerId: string): Promise<CandidateMatchSkillRow[]> {
    return this.db
      .select({
        skillId: workerSkills.skillId,
        industryId: workerSkills.industryId,
        monthsBucketed: workerSkills.monthsBucketed,
        wants: workerSkills.wants,
        source: workerSkills.source,
      })
      .from(workerSkills)
      .where(eq(workerSkills.workerId, workerId))
      .orderBy(desc(workerSkills.monthsBucketed), asc(workerSkills.skillId));
  }

  async industryTenure(workerId: string): Promise<CandidateTenureRow[]> {
    return this.db
      .select({
        industryId: workerIndustryTenure.industryId,
        calendarMonths: workerIndustryTenure.calendarMonths,
      })
      .from(workerIndustryTenure)
      .where(eq(workerIndustryTenure.workerId, workerId))
      .orderBy(desc(workerIndustryTenure.calendarMonths), asc(workerIndustryTenure.industryId));
  }

  /**
   * The résumé history, newest first (`generated_resumes_worker_generated_idx`), at most `limit`
   * rows, plus the total. No download key — `has_pdf` is reduced to a boolean in Postgres.
   */
  async resumeVersions(
    workerId: string,
    limit: number,
  ): Promise<{ rows: CandidateResumeVersionRow[]; total: number }> {
    const rows = await this.db
      .select({
        id: generatedResumes.id,
        version: generatedResumes.version,
        generationTrigger: generatedResumes.generationTrigger,
        generationSource: generatedResumes.generationSource,
        renderStatus: generatedResumes.renderStatus,
        templateId: generatedResumes.templateId,
        hasPdf: sql<boolean>`${generatedResumes.pdfStorageKey} IS NOT NULL`,
        generatedAt: generatedResumes.generatedAt,
        renderedAt: generatedResumes.renderedAt,
        total: sql<number>`(count(*) OVER ())::int`,
      })
      .from(generatedResumes)
      .where(eq(generatedResumes.workerId, workerId))
      .orderBy(desc(generatedResumes.generatedAt), desc(generatedResumes.id))
      .limit(limit);
    return {
      rows: rows.map(({ total: _total, ...row }) => row),
      total: rows[0]?.total ?? 0,
    };
  }

  /**
   * The account aggregates in ONE statement: unrevoked devices (count, newest app version, last
   * sighting), application and unlock counts, the LATEST consent row, the open flag, and the form
   * level. Opaque codes and counts only — no push token, device hash, IP hash or user agent.
   */
  async account(workerId: string): Promise<CandidateAccountRow> {
    const id = sql`${workerId}::uuid`;
    const aggregates = this.db
      .select({
        deviceCount: sql<number>`(
          SELECT count(*)::int FROM ${workerDevices}
          WHERE ${workerDevices.workerId} = ${id} AND ${workerDevices.revokedAt} IS NULL)`,
        latestAppVersion: sql<string | null>`(
          SELECT ${workerDevices.appVersion} FROM ${workerDevices}
          WHERE ${workerDevices.workerId} = ${id} AND ${workerDevices.revokedAt} IS NULL
          ORDER BY ${workerDevices.lastSeenAt} DESC, ${workerDevices.id} DESC LIMIT 1)`,
        lastSeenAt: sql<Date | string | null>`(
          SELECT max(${workerDevices.lastSeenAt}) FROM ${workerDevices}
          WHERE ${workerDevices.workerId} = ${id} AND ${workerDevices.revokedAt} IS NULL)`,
        appliedCount: sql<number>`(
          SELECT count(*)::int FROM ${applications}
          WHERE ${applications.workerId} = ${id} AND ${applications.action} = 'applied')`,
        skippedCount: sql<number>`(
          SELECT count(*)::int FROM ${applications}
          WHERE ${applications.workerId} = ${id} AND ${applications.action} = 'skipped')`,
        unlockCount: sql<number>`(
          SELECT count(*)::int FROM ${unlocks} WHERE ${unlocks.workerId} = ${id})`,
        formLevel: sql<string | null>`(
          SELECT ${workerProfilingTiers.tier} FROM ${workerProfilingTiers}
          WHERE ${workerProfilingTiers.workerId} = ${id})`,
      })
      .from(workers)
      .where(eq(workers.id, workerId))
      .limit(1);

    const [rows, consentRows, flagRows] = await Promise.all([
      aggregates,
      this.db
        .select({
          consentVersion: workerConsents.consentVersion,
          purposes: workerConsents.purposes,
          acceptedAt: workerConsents.acceptedAt,
          revokedAt: workerConsents.revokedAt,
        })
        .from(workerConsents)
        .where(eq(workerConsents.workerId, workerId))
        .orderBy(desc(workerConsents.acceptedAt), desc(workerConsents.id))
        .limit(1),
      this.db
        .select({ reasonCode: workerFlags.flagReasonCode, flaggedAt: workerFlags.flaggedAt })
        .from(workerFlags)
        .where(and(eq(workerFlags.workerId, workerId), sql`${workerFlags.resolvedAt} IS NULL`))
        .limit(1),
    ]);

    const a = rows[0];
    return {
      deviceCount: a?.deviceCount ?? 0,
      latestAppVersion: a?.latestAppVersion ?? null,
      lastSeenAt: toDateOrNull(a?.lastSeenAt ?? null),
      appliedCount: a?.appliedCount ?? 0,
      skippedCount: a?.skippedCount ?? 0,
      unlockCount: a?.unlockCount ?? 0,
      formLevel: a?.formLevel ?? null,
      consent: consentRows[0]
        ? { ...consentRows[0], purposes: [...(consentRows[0].purposes ?? [])] }
        : null,
      flag: flagRows[0] ?? null,
    };
  }
}

/** A scalar-subquery timestamp comes back from the driver as a string; normalise it. */
function toDateOrNull(value: Date | string | null): Date | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
