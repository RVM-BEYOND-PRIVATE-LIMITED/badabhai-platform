import { vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import type { Database, WorkerProfile } from "@badabhai/db";
import type { AiCostRecorder } from "../../ai/ai-cost-recorder.service";
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
import type { ChatEditRegeneration } from "../../resume/resume.dto";
import type { ConsentRepository } from "../../consent/consent.repository";
import type { EditProposalStore, StoredEditProposal } from "./edit-proposal.store";
import { CompanionEditService } from "./companion-edit.service";

/**
 * The shared harness for the edit-path suites (`companion-edit.*.test.ts`).
 *
 * Every collaborator is a spy with a MINIMAL honest shape, so a test asserts what the service
 * did — which writer it called, with which rows, on which transaction — rather than re-testing
 * the writers (their own suites do that).
 *
 * THE TRANSACTION HAS REAL SEMANTICS. A writer handed the transaction's handle STAGES its write
 * on it; `db.transaction` moves the staged writes to `committed` only when the callback returns,
 * and drops them when it throws. A writer called WITHOUT the handle autocommits straight to
 * `committed`, as a real repository would. So a rollback is observed (a write that happened and
 * then was undone), not inferred from a throw.
 */

/** One writer call, as the harness recorded it. */
export interface WriteRecord {
  readonly writer:
    | "employment"
    | "skills"
    | "languages"
    | "qualifications"
    | "occupations"
    | "preferences";
  readonly args: readonly unknown[];
}

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
  readonly resumes: { queueChatEditRegeneration: ReturnType<typeof vi.fn> };
  readonly consents: { findLatestByWorker: ReturnType<typeof vi.fn> };
  readonly events: { emit: ReturnType<typeof vi.fn> };
  readonly cost: { record: ReturnType<typeof vi.fn> };
  readonly db: { transaction: ReturnType<typeof vi.fn> };
  readonly tx: { readonly sentinel: "tx"; readonly staged: WriteRecord[] };
  /** Writes that SURVIVED: committed transactions plus any write made outside one. */
  readonly committed: WriteRecord[];
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
    /** What the résumé seam decides on Haan (default `queued`). */
    regen?: ChatEditRegeneration;
    /** The résumé seam breaks its never-throws contract. */
    regenThrows?: boolean;
    /** The worker's latest consent row. Default: active, naming `resume_generation`. */
    consent?: { revokedAt: Date | null; purposes: string[] } | null;
    /** Every section writer throws. */
    writerThrows?: boolean;
    /** Only these section writers throw — the others write (row 1 lands, row 2 fails). */
    failingWriters?: readonly WriteRecord["writer"][];
  } = {},
): Harness {
  const tx = { sentinel: "tx" as const, staged: [] as WriteRecord[] };
  const committed: WriteRecord[] = [];
  const failing = new Set(opts.failingWriters ?? []);
  /** Stage on the transaction, or autocommit without one; throw when scripted to. */
  const write = (writer: WriteRecord["writer"], handle: unknown, args: readonly unknown[]) => {
    if (opts.writerThrows || failing.has(writer)) throw new Error(`${writer} writer boom`);
    (handle === tx ? tx.staged : committed).push({ writer, args });
  };
  const txOf = (options: unknown): unknown => (options as { tx?: unknown } | undefined)?.tx;
  const proposals = {
    save: vi.fn(async () => opts.storeSave ?? true),
    load: vi.fn(async () => opts.proposal ?? null),
    delete: vi.fn(async () => undefined),
  };
  const ai = { companionEditParse: vi.fn(async () => opts.parse ?? null) };
  const profiles = {
    setResumeSkillLabels: vi.fn(async (...args: unknown[]) => {
      write("skills", args[2], args);
    }),
  };
  const employment = {
    getForWorker: vi.fn(async () => ({
      employments: opts.employmentViews ?? [],
      unreadable_count: 0,
      employment_suggestions: [],
    })),
    replaceForWorker: vi.fn(async (...args: unknown[]) => {
      write("employment", txOf(args[3]), args);
      return { worker_id: WORKER_ID, employer_count: 0 };
    }),
  };
  const languages = {
    getForWorker: vi.fn(async () => ({
      languages: opts.languageEntries ?? [],
      partial: false,
      dropped_count: 0,
    })),
    replaceForWorker: vi.fn(async (...args: unknown[]) => {
      write("languages", txOf(args[3]), args);
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
    replaceForWorker: vi.fn(async (...args: unknown[]) => {
      write("qualifications", txOf(args[3]), args);
      return { worker_id: WORKER_ID, certificate_count: 0, education_count: 0 };
    }),
  };
  const occupations = {
    getForWorker: vi.fn(async () => ({
      occupations: opts.occupationEntries ?? [],
      partial: false,
      dropped_count: 0,
    })),
    replaceForWorker: vi.fn(async (...args: unknown[]) => {
      write("occupations", txOf(args[3]), args);
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
    setForWorker: vi.fn(async (...args: unknown[]) => {
      write("preferences", txOf(args[3]), args);
      return { worker_id: WORKER_ID, keys_written: 1, keys_cleared: 0 };
    }),
  };
  const workerSkills = { rebuildQuietly: vi.fn(async () => undefined) };
  const resumes = {
    queueChatEditRegeneration: vi.fn(async (): Promise<ChatEditRegeneration> => {
      if (opts.regenThrows) throw new Error("resume seam boom");
      return opts.regen ?? "queued";
    }),
  };
  const consents = {
    findLatestByWorker: vi.fn(async () =>
      "consent" in opts
        ? (opts.consent ?? undefined)
        : { revokedAt: null, purposes: ["profiling", "resume_generation"] },
    ),
  };
  const events = { emit: vi.fn(async (params: unknown) => params) };
  const cost = { record: vi.fn(async () => undefined) };
  const db = {
    // COMMIT on return, ROLLBACK on throw — the staged writes either all land or none do.
    transaction: vi.fn(async (cb: (executor: object) => Promise<unknown>) => {
      tx.staged.length = 0;
      try {
        const out = await cb(tx);
        committed.push(...tx.staged);
        return out;
      } finally {
        tx.staged.length = 0;
      }
    }),
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
    cost as unknown as AiCostRecorder,
    consents as unknown as ConsentRepository,
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
    consents,
    events,
    cost,
    db,
    tx,
    committed,
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
