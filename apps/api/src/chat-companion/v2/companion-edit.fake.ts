import { vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import type { Database, WorkerProfile } from "@badabhai/db";
import type { AiService } from "../../ai/ai.service";
import type { EventsService } from "../../events/events.service";
import type { ProfilesRepository } from "../../profiles/profiles.repository";
import type { WorkerEmploymentService } from "../../profiles/worker-employment.service";
import type { WorkerLanguagesService } from "../../profiles/worker-languages.service";
import type { WorkerQualificationsService } from "../../profiles/worker-qualifications.service";
import type { WorkerOccupationsService } from "../../profiles/worker-occupations.service";
import type { WorkerPreferencesService } from "../../profiles/worker-preferences.service";
import type { WorkerSkillsService } from "../../match/worker-skills.service";
import type { ResumeService } from "../../resume/resume.service";
import type { EditProposalStore, StoredEditProposal } from "./edit-proposal.store";
import { CompanionEditService } from "./companion-edit.service";

/**
 * The shared harness for the edit-path suites (`companion-edit.*.test.ts`).
 *
 * Every collaborator is a spy with a MINIMAL honest shape, so a test asserts what the service
 * did — which writer it called, with which rows, on which transaction — rather than re-testing
 * the writers (their own suites do that). `db.transaction` runs the callback with a sentinel
 * handle and, when scripted, throws THROUGH it so the rollback path is exercised for real.
 */

export interface Harness {
  readonly service: CompanionEditService;
  readonly proposals: {
    save: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  readonly ai: { companionEditParse: ReturnType<typeof vi.fn> };
  readonly profiles: { setResumeSkillLabels: ReturnType<typeof vi.fn> };
  readonly employment: {
    getForWorker: ReturnType<typeof vi.fn>;
    replaceForWorker: ReturnType<typeof vi.fn>;
  };
  readonly languages: {
    getForWorker: ReturnType<typeof vi.fn>;
    replaceForWorker: ReturnType<typeof vi.fn>;
  };
  readonly qualifications: {
    getForWorker: ReturnType<typeof vi.fn>;
    replaceForWorker: ReturnType<typeof vi.fn>;
  };
  readonly occupations: {
    getForWorker: ReturnType<typeof vi.fn>;
    replaceForWorker: ReturnType<typeof vi.fn>;
  };
  readonly preferences: {
    getForWorker: ReturnType<typeof vi.fn>;
    setForWorker: ReturnType<typeof vi.fn>;
  };
  readonly workerSkills: { rebuildQuietly: ReturnType<typeof vi.fn> };
  readonly resumes: { generate: ReturnType<typeof vi.fn> };
  readonly events: { emit: ReturnType<typeof vi.fn> };
  readonly db: { transaction: ReturnType<typeof vi.fn> };
  readonly tx: object;
}

export const WORKER_ID = "11111111-1111-4111-8111-111111111111";
export const PROFILE_ID = "22222222-2222-4222-8222-222222222222";

/** A profile row with a draft the skills snapshot can read. */
export function profileRow(over: Partial<WorkerProfile> = {}): WorkerProfile {
  return {
    id: PROFILE_ID,
    workerId: WORKER_ID,
    rawProfile: {
      skills: ["skill_milling"],
      skill_labels: ["MIG welding"],
      machines: [],
      experiences: [],
      education: [],
      certifications: [],
    },
    ...over,
  } as unknown as WorkerProfile;
}

export function setup(
  opts: {
    parse?: unknown;
    proposal?: StoredEditProposal | null;
    storeSave?: boolean;
    employmentViews?: readonly Record<string, unknown>[];
    languageEntries?: readonly Record<string, unknown>[];
    occupationEntries?: readonly Record<string, unknown>[];
    qualificationLists?: {
      certificates?: readonly Record<string, unknown>[];
      educations?: readonly Record<string, unknown>[];
      trainings?: readonly Record<string, unknown>[];
    };
    preferenceValues?: Record<string, unknown>;
    generateThrows?: { status?: number } | null;
    writerThrows?: boolean;
  } = {},
): Harness {
  const tx = { sentinel: "tx" };
  const proposals = {
    save: vi.fn(async () => opts.storeSave ?? true),
    load: vi.fn(async () => opts.proposal ?? null),
    delete: vi.fn(async () => undefined),
  };
  const ai = { companionEditParse: vi.fn(async () => opts.parse ?? null) };
  const profiles = { setResumeSkillLabels: vi.fn(async () => undefined) };
  const employment = {
    getForWorker: vi.fn(async () => ({
      employments: opts.employmentViews ?? [],
      unreadable_count: 0,
      employment_suggestions: [],
    })),
    replaceForWorker: vi.fn(async () => {
      if (opts.writerThrows) throw new Error("employment writer boom");
      return { worker_id: WORKER_ID, employer_count: 0 };
    }),
  };
  const languages = {
    getForWorker: vi.fn(async () => ({
      languages: opts.languageEntries ?? [],
      partial: false,
      dropped_count: 0,
    })),
    replaceForWorker: vi.fn(async () => {
      if (opts.writerThrows) throw new Error("languages writer boom");
      return { worker_id: WORKER_ID, language_count: 0 };
    }),
  };
  const qualifications = {
    getForWorker: vi.fn(async () => ({
      certificates: opts.qualificationLists?.certificates ?? [],
      educations: opts.qualificationLists?.educations ?? [],
      trainings: opts.qualificationLists?.trainings ?? [],
      partial: [],
      dropped_count: 0,
    })),
    replaceForWorker: vi.fn(async () => {
      if (opts.writerThrows) throw new Error("qualifications writer boom");
      return { worker_id: WORKER_ID, certificate_count: 0, education_count: 0 };
    }),
  };
  const occupations = {
    getForWorker: vi.fn(async () => ({
      occupations: opts.occupationEntries ?? [],
      partial: false,
      dropped_count: 0,
    })),
    replaceForWorker: vi.fn(async () => {
      if (opts.writerThrows) throw new Error("occupations writer boom");
      return { worker_id: WORKER_ID, occupation_count: 0 };
    }),
  };
  const preferences = {
    getForWorker: vi.fn(async () => ({
      values: {
        shift: null,
        job_type: null,
        willing_to_travel: null,
        willing_to_relocate: null,
        accommodation_needed: null,
        salary_expected_max: null,
        salary_expected_min: null,
        availability: null,
        preferred_cities: null,
        work_types: null,
        documents_ready: null,
        languages: null,
        ...(opts.preferenceValues ?? {}),
      },
      partial: [],
      dropped_count: 0,
    })),
    setForWorker: vi.fn(async () => {
      if (opts.writerThrows) throw new Error("preferences writer boom");
      return { worker_id: WORKER_ID, keys_written: 1, keys_cleared: 0 };
    }),
  };
  const workerSkills = { rebuildQuietly: vi.fn(async () => undefined) };
  const resumes = {
    generate: vi.fn(async () => {
      if (opts.generateThrows) throw Object.assign(new Error("cap"), opts.generateThrows);
      return {};
    }),
  };
  const events = { emit: vi.fn(async (params: unknown) => params) };
  const db = {
    transaction: vi.fn(async (cb: (executor: object) => Promise<unknown>) => cb(tx)),
  };
  const config = {
    CHAT_COMPANION_V2_EDIT_MAX_ROWS: 3,
    CHAT_COMPANION_V2_PROPOSAL_TTL_SECONDS: 600,
    CHAT_COMPANION_V2_EDIT_ENABLED: true,
  } as unknown as ServerConfig;

  const service = new CompanionEditService(
    config,
    db as unknown as Database,
    ai as unknown as AiService,
    proposals as unknown as EditProposalStore,
    profiles as unknown as ProfilesRepository,
    employment as unknown as WorkerEmploymentService,
    languages as unknown as WorkerLanguagesService,
    qualifications as unknown as WorkerQualificationsService,
    occupations as unknown as WorkerOccupationsService,
    preferences as unknown as WorkerPreferencesService,
    workerSkills as unknown as WorkerSkillsService,
    resumes as unknown as ResumeService,
    events as unknown as EventsService,
  );
  return {
    service,
    proposals,
    ai,
    profiles,
    employment,
    languages,
    qualifications,
    occupations,
    preferences,
    workerSkills,
    resumes,
    events,
    db,
    tx,
  };
}

/** A stored proposal with one row, for the confirm/cancel suites. */
export function storedProposal(over: Partial<StoredEditProposal> = {}): StoredEditProposal {
  return {
    proposal_id: "33333333-3333-4333-8333-333333333333",
    expires_at: "2026-09-29T14:00:00.000Z",
    rows: [
      {
        row_id: "44444444-4444-4444-8444-444444444444",
        section: "languages",
        op: "delete",
        field: "language",
        value: null,
        before: "hindi",
        section_label: "Bhasha",
        target: { language: "hindi" },
      },
    ],
    ...over,
  };
}
