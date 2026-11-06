import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import type { Database, WorkerAdminOverrideFactKey, WorkerProfile } from "@badabhai/db";
import type { RequestContext } from "../../common/request-context";
import { PiiCryptoService } from "../../common/pii-crypto.service";
import { WorkerSkillsRepository } from "../../match/worker-skills.repository";
import { ProfileSkillsRepository } from "../../profiles/profile-skills.repository";
import { ProfilesRepository } from "../../profiles/profiles.repository";
import { storedEducationField, storedEmployerName } from "../../profiles/title-case-on-write";
import { WorkerAttributesRepository } from "../../profiles/worker-attributes.repository";
import { WorkerEmploymentRepository } from "../../profiles/worker-employment.repository";
import type { EmploymentEntryDto } from "../../profiles/worker-employment.dto";
import { WorkerLanguagesRepository } from "../../profiles/worker-languages.repository";
import type { LanguageEntryDto } from "../../profiles/worker-languages.dto";
import { WorkerOccupationsRepository } from "../../profiles/worker-occupations.repository";
import { WorkerPreferencesService } from "../../profiles/worker-preferences.service";
import type { SetMyPreferencesDto } from "../../profiles/worker-preferences.dto";
import { WorkerQualificationsRepository } from "../../profiles/worker-qualifications.repository";
import type {
  CertificateEntryDto,
  EducationEntryDto,
  TrainingEntryDto,
} from "../../profiles/worker-qualifications.dto";
import { WorkersRepository } from "../../workers/workers.repository";
import { AdminCorrectionsRepository } from "./admin-corrections.repository";

/**
 * #2561 PR 2 — the DOMAIN half of the correction layer (ADR-0062 §4).
 *
 * `readPrevious` captures the last non-admin effective value for the `{corrected, previous}`
 * envelope; `write` runs the SAME store writer the worker path runs, on the correction's
 * transaction, so a revert restores the exact shape the worker's own page would. The location
 * keys are handled by `AdminCorrectionService` itself (their writer predates this service and
 * its behaviour is pinned by the PR 1 tests); every other key lands here.
 *
 * All reads are transaction-scoped where the repository supports it. A work-history or licence
 * row that cannot be decrypted fails the correction with a 409 instead of storing a `previous`
 * that would silently drop it on revert.
 */
@Injectable()
export class AdminCorrectionFactsService {
  constructor(
    private readonly repo: AdminCorrectionsRepository,
    private readonly workers: WorkersRepository,
    private readonly profiles: ProfilesRepository,
    private readonly profileSkills: ProfileSkillsRepository,
    private readonly employment: WorkerEmploymentRepository,
    private readonly qualifications: WorkerQualificationsRepository,
    private readonly languages: WorkerLanguagesRepository,
    private readonly occupations: WorkerOccupationsRepository,
    private readonly attributes: WorkerAttributesRepository,
    private readonly workerSkills: WorkerSkillsRepository,
    private readonly preferences: WorkerPreferencesService,
    private readonly pii: PiiCryptoService,
  ) {}

  /** The worker's current profile, or a 400 when none exists yet. */
  private async profileFor(tx: Database, workerId: string): Promise<WorkerProfile> {
    const profile = await this.workers.latestProfile(workerId, tx);
    if (!profile) {
      throw new BadRequestException("Worker has no profile to correct yet");
    }
    return profile;
  }

  private decrypt(token: string, what: string): string {
    try {
      return this.pii.decrypt(token);
    } catch {
      throw new ConflictException(
        `This worker's ${what} cannot be read, so the correction cannot be reverted safely`,
      );
    }
  }

  // ----- previous values --------------------------------------------------------------------

  async readPrevious(
    tx: Database,
    workerId: string,
    factKey: WorkerAdminOverrideFactKey,
  ): Promise<unknown> {
    switch (factKey) {
      case "current_city":
      case "preferred_locations":
        throw new Error("location corrections are read by AdminCorrectionService");
      case "trade": {
        const profile = await this.profileFor(tx, workerId);
        return profile.canonicalTradeId ?? null;
      }
      case "role": {
        const profile = await this.profileFor(tx, workerId);
        return profile.canonicalRoleId ?? null;
      }
      case "secondary_roles":
        return this.occupations.loadForWorker(workerId, tx);
      case "skills": {
        const profile = await this.profileFor(tx, workerId);
        return profile.skills ?? [];
      }
      case "experience": {
        const profile = await this.profileFor(tx, workerId);
        return this.totalYearsOf(profile.experience);
      }
      case "work_history":
        return this.readWorkHistory(tx, workerId);
      case "education":
        return (await this.qualifications.loadForResume(workerId, tx)).educations;
      case "certifications":
        return this.readCertificates(tx, workerId);
      case "training":
        return (await this.qualifications.loadForResume(workerId, tx)).trainings;
      case "languages": {
        const rows = await this.languages.loadForResume(workerId, tx);
        return rows.map((row) => ({
          language: row.language,
          can_speak: row.canSpeak,
          can_read: row.canRead,
          can_write: row.canWrite,
        }));
      }
      case "salary_expected":
        return this.readSalary(tx, workerId);
      case "salary_period":
        return this.attributeText(tx, workerId, "salary_period");
      case "availability":
        return this.readAvailability(tx, workerId);
      case "shift":
        return this.attributeText(tx, workerId, "shift_preference");
      case "relocation":
        return this.attributeBool(tx, workerId, "relocation_willingness");
      case "accommodation":
        return this.attributeBool(tx, workerId, "accommodation_needed");
      case "job_type":
        return this.attributeText(tx, workerId, "job_type");
      case "work_types":
        return this.attributeList(tx, workerId, "work_types");
      case "commute_max_km":
        return this.attributeNumber(tx, workerId, "commute_max_km");
      case "willing_to_travel":
        return this.attributeBool(tx, workerId, "willing_to_travel");
      case "documents_ready":
        return this.attributeList(tx, workerId, "documents_ready");
    }
  }

  private totalYearsOf(experience: unknown): number | null {
    if (typeof experience !== "object" || experience === null) return null;
    const value = (experience as Record<string, unknown>)["total_years"];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  private async readWorkHistory(
    tx: Database,
    workerId: string,
  ): Promise<{ employments: unknown[] }> {
    const records = await this.employment.loadForWorkerEdit(workerId, tx);
    const employments = records.map((record) => {
      const employerName = this.decrypt(record.employerNameEnc, "work history");
      if (record.roles.length === 0) {
        throw new ConflictException(
          "This worker's work history contains an employment with no role, so it cannot be corrected safely",
        );
      }
      const base = {
        employer_name: employerName,
        employer_city: record.employerCity,
        employer_state: record.employerState,
        start_ym: record.startYm,
        end_ym: record.endYm,
      };
      if (record.roles.length === 1) {
        const only = record.roles[0]!;
        return {
          ...base,
          role_label: only.roleLabel,
          work_done: only.workDone,
          work_done_voice_note_id: only.workDoneVoiceNoteId,
        };
      }
      return {
        ...base,
        roles: record.roles.map((role) => ({
          role_label: role.roleLabel,
          start_ym: role.startYm,
          end_ym: role.endYm,
          work_done: role.workDone,
          work_done_voice_note_id: role.workDoneVoiceNoteId,
        })),
      };
    });
    return { employments };
  }

  private async readCertificates(
    tx: Database,
    workerId: string,
  ): Promise<unknown[]> {
    const stored = await this.qualifications.loadForResume(workerId, tx);
    return stored.certificates.map((certificate) => ({
      name: certificate.name,
      issuer: certificate.issuer,
      year: certificate.year,
      licence_number:
        certificate.licenceNumberEnc == null
          ? null
          : this.decrypt(certificate.licenceNumberEnc, "certificate licence number"),
      licence_expiry: certificate.licenceExpiry,
    }));
  }

  private attributeRow(
    tx: Database,
    workerId: string,
    key: string,
  ): Promise<
    | {
        valueKind: string;
        valueBool: boolean | null;
        valueNumber: string | null;
        valueText: string | null;
        valueTextList: string[] | null;
        valueJson: Record<string, unknown> | null;
      }
    | undefined
  > {
    return this.attributes
      .loadKeys(workerId, [key], tx)
      .then((rows) => rows[0]);
  }

  private async attributeText(
    tx: Database,
    workerId: string,
    key: string,
  ): Promise<string | null> {
    const row = await this.attributeRow(tx, workerId, key);
    return row?.valueText ?? null;
  }

  private async attributeBool(
    tx: Database,
    workerId: string,
    key: string,
  ): Promise<boolean | null> {
    const row = await this.attributeRow(tx, workerId, key);
    return row?.valueBool ?? null;
  }

  private async attributeNumber(
    tx: Database,
    workerId: string,
    key: string,
  ): Promise<number | null> {
    const row = await this.attributeRow(tx, workerId, key);
    if (row?.valueNumber == null) return null;
    const value = Number(row.valueNumber);
    return Number.isFinite(value) ? value : null;
  }

  private async attributeList(
    tx: Database,
    workerId: string,
    key: string,
  ): Promise<string[]> {
    const row = await this.attributeRow(tx, workerId, key);
    return row?.valueTextList ?? [];
  }

  private async readAvailability(tx: Database, workerId: string): Promise<unknown> {
    const row = await this.attributeRow(tx, workerId, "availability");
    if (row?.valueJson !== null && row?.valueJson !== undefined) return row.valueJson;
    // A legacy row may carry the status as text; normalise it to the object shape the writer
    // accepts, so a revert does not fail on a value the old build stored.
    if (row?.valueText !== null && row?.valueText !== undefined) return { status: row.valueText };
    return null;
  }

  private async readSalary(
    tx: Database,
    workerId: string,
  ): Promise<{ min: number | null; max: number | null } | null> {
    const rows = await this.attributes.loadKeys(
      workerId,
      ["salary_expected_min", "salary_expected_max"],
      tx,
    );
    const number = (key: string): number | null => {
      const row = rows.find((candidate) => candidate.attributeKey === key);
      if (row?.valueNumber == null) return null;
      const value = Number(row.valueNumber);
      return Number.isFinite(value) ? value : null;
    };
    const min = number("salary_expected_min");
    const max = number("salary_expected_max");
    return min === null && max === null ? null : { min, max };
  }

  // ----- writes -------------------------------------------------------------------------------

  async write(
    tx: Database,
    ctx: RequestContext,
    workerId: string,
    factKey: WorkerAdminOverrideFactKey,
    value: unknown,
    overrideId: string,
  ): Promise<void> {
    switch (factKey) {
      case "current_city":
      case "preferred_locations":
        throw new Error("location corrections are written by AdminCorrectionService");
      case "trade": {
        const profile = await this.profileFor(tx, workerId);
        await this.profiles.setCanonicalId(
          profile.id,
          "canonicalTradeId",
          value as string | null,
          tx,
        );
        return;
      }
      case "role": {
        const profile = await this.profileFor(tx, workerId);
        await this.profiles.setCanonicalId(profile.id, "canonicalRoleId", value as string | null, tx);
        return;
      }
      case "secondary_roles":
        await this.occupations.replaceForWorker(workerId, value as string[], tx);
        return;
      case "skills": {
        const ids = value as string[];
        const profile = await this.profileFor(tx, workerId);
        const existing = await this.repo.existingSkillIds(tx, ids);
        if (existing.length !== new Set(ids).size) {
          const known = new Set(existing);
          const missing = ids.filter((id) => !known.has(id));
          throw new BadRequestException(`unknown skill id: ${missing.join(", ")}`);
        }
        // The authored rows: only the `ops` rows this layer owns are replaced; the worker's own
        // `worker_confirmed`/`llm_extraction` rows stay intact (ADR-0062 §4).
        await this.profileSkills.replaceAdminSkills(profile.id, ids, overrideId, tx);
        await this.profiles.setSkillLists(profile.id, ids, tx);
        // The matching projection: `ops` rows survive every later derived rebuild.
        await this.workerSkills.replaceOpsSkills(workerId, ids, tx);
        return;
      }
      case "experience": {
        const profile = await this.profileFor(tx, workerId);
        await this.profiles.setExperienceTotal(profile.id, value as number | null, tx);
        return;
      }
      case "work_history":
        await this.writeWorkHistory(tx, workerId, value);
        return;
      case "education":
        await this.qualifications.replaceForWorker(
          workerId,
          {
            educations: (value as EducationEntryDto[]).map((entry) => ({
              ...entry,
              field: storedEducationField(entry.field),
            })),
          },
          tx,
        );
        return;
      case "certifications":
        await this.qualifications.replaceForWorker(
          workerId,
          {
            certificates: (value as CertificateEntryDto[]).map((certificate) => ({
              name: certificate.name,
              issuer: certificate.issuer,
              year: certificate.year,
              licenceNumberEnc:
                certificate.licence_number === null
                  ? null
                  : this.pii.encrypt(certificate.licence_number),
              licenceExpiry: certificate.licence_expiry,
            })),
          },
          tx,
        );
        return;
      case "training":
        await this.qualifications.replaceForWorker(
          workerId,
          { trainings: value as TrainingEntryDto[] },
          tx,
        );
        return;
      case "languages":
        await this.languages.replaceForWorker(
          workerId,
          (value as LanguageEntryDto[]).map((entry) => ({
            language: entry.language,
            canSpeak: entry.can_speak,
            canRead: entry.can_read,
            canWrite: entry.can_write,
          })),
          tx,
        );
        return;
      case "salary_expected": {
        const salary = value as { min: number | null; max: number | null } | null;
        await this.preferences.setForWorker(
          workerId,
          {
            salary_expected_min: salary?.min ?? null,
            salary_expected_max: salary?.max ?? null,
            touched_only: true,
          },
          ctx,
          { tx, source: "admin_correction" },
        );
        return;
      }
      case "salary_period":
        await this.writePreference(workerId, ctx, tx, { salary_period: value as string | null });
        return;
      case "availability":
        await this.writePreference(workerId, ctx, tx, {
          availability: value as SetMyPreferencesDto["availability"],
        });
        return;
      case "shift":
        await this.writePreference(workerId, ctx, tx, { shift: value as string | null });
        return;
      case "relocation":
        await this.writePreference(workerId, ctx, tx, { willing_to_relocate: value as boolean | null });
        return;
      case "accommodation":
        await this.writePreference(workerId, ctx, tx, {
          accommodation_needed: value as boolean | null,
        });
        return;
      case "job_type":
        await this.writePreference(workerId, ctx, tx, { job_type: value as string | null });
        return;
      case "work_types":
        await this.writePreference(workerId, ctx, tx, { work_types: value as string[] });
        return;
      case "commute_max_km":
        await this.writePreference(workerId, ctx, tx, { commute_max_km: value as number | null });
        return;
      case "willing_to_travel":
        await this.writePreference(workerId, ctx, tx, {
          willing_to_travel: value as boolean | null,
        });
        return;
      case "documents_ready":
        await this.writePreference(workerId, ctx, tx, { documents_ready: value as string[] });
        return;
    }
  }

  private async writePreference(
    workerId: string,
    ctx: RequestContext,
    tx: Database,
    body: SetMyPreferencesDto,
  ): Promise<void> {
    await this.preferences.setForWorker(
      workerId,
      { ...body, touched_only: true },
      ctx,
      { tx, source: "admin_correction" },
    );
  }

  private async writeWorkHistory(
    tx: Database,
    workerId: string,
    value: unknown,
  ): Promise<void> {
    const employments = (value as { employments: EmploymentEntryDto[] }).employments;
    const rows = employments.map((employment) => ({
      employerNameEnc: this.pii.encrypt(storedEmployerName(employment.employer_name)),
      employerCity: employment.employer_city ?? null,
      employerState: employment.employer_state ?? null,
      startYm: employment.start_ym ?? null,
      endYm: employment.end_ym ?? null,
      durationStated: employment.start_ym !== null,
      roles:
        employment.roles !== undefined
          ? employment.roles.map((role) => ({
              roleLabel: role.role_label,
              startYm: role.start_ym,
              endYm: role.end_ym,
              workDone: role.work_done,
              workDoneVoiceNoteId: role.work_done_voice_note_id,
            }))
          : [
              {
                roleLabel: employment.role_label as string,
                startYm: employment.start_ym,
                endYm: employment.end_ym,
                workDone: employment.work_done,
                workDoneVoiceNoteId: employment.work_done_voice_note_id,
              },
            ],
    }));
    // `preserveWhenEmpty: false` makes an explicit empty list CLEAR the history, which is what
    // an admin revert of a first correction (previous = []) must do.
    await this.employment.replaceForWorker(workerId, rows, {
      tx,
      preserveWhenEmpty: false,
    });
  }
}
