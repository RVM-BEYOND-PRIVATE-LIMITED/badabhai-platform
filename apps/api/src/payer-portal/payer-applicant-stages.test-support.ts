import type { ApplicantPostingKind } from "@badabhai/types";
import type { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { PayerApplicantStagesService } from "./payer-applicant-stages.service";
import type {
  ApplicantStageKey,
  PayerApplicantStagesRepository,
  StoredApplicantStage,
} from "./payer-applicant-stages.repository";

/**
 * Test support for the payer applicant pipeline board (owner ruling 2026-10-07). Not compiled
 * into the build (`*.test-support.ts` is excluded by tsconfig.build.json).
 */

/** The message every repository call fails with while the flag is off. */
export const STAGES_TABLE_READ_WHILE_OFF =
  "payer_applicant_stages must not be touched while PAYER_APPLICANT_STAGES_ENABLED is off";

/**
 * The REAL stages service with the flag OFF over a repository whose every method throws — so a
 * suite built on it proves, as a side effect of every case, that flag-off code never names the
 * table (migration 0134 may not be applied).
 */
export function stagesOff(): PayerApplicantStagesService {
  const repo = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error(STAGES_TABLE_READ_WHILE_OFF);
      },
    },
  ) as unknown as PayerApplicantStagesRepository;
  // Off answers before it resolves anyone's tenancy, so a resolve here is a defect too.
  const tenancy = {
    resolve: () => {
      throw new Error("the stages service must not resolve tenancy while its flag is off");
    },
  } as unknown as PayerTenantScopeService;
  return new PayerApplicantStagesService(
    repo,
    {} as never,
    { PAYER_APPLICANT_STAGES_ENABLED: false },
    tenancy,
  );
}

/** One row of the in-memory board. */
export interface MemoryStageRow extends ApplicantStageKey {
  stage: string;
  actorPayerId: string;
  updatedAt: Date;
}

/**
 * An in-memory `payer_applicant_stages` with the repository's contract, for unit suites that run
 * the service with the flag ON. Ownership and feed membership are supplied by the caller (each
 * mirrors its SQL's WHERE); `lockStage`/`insertStage`/`updateStage` behave as the table does —
 * one row per key, an insert that finds one returns `false`.
 */
export function memoryStagesRepo(world: {
  /** posting id → [owner tenant key, kind]. Mirrors `findOwnedJobRef` (jobs-first). */
  postings: ReadonlyMap<string, { owner: string; kind: ApplicantPostingKind }>;
  /** Whether (kind, posting, worker) is on that posting's feed. */
  isMember: (key: ApplicantStageKey) => boolean;
}) {
  const rows = new Map<string, MemoryStageRow>();
  const id = (k: ApplicantStageKey) => `${k.postingKind}|${k.postingId}|${k.workerId}`;
  const tx = { tx: true } as never;
  const repo = {
    rows,
    withTransaction: async <T>(cb: (t: never) => Promise<T>): Promise<T> => cb(tx),
    findOwnedPostingKind: async (postingId: string, tenant: string) => {
      const p = world.postings.get(postingId);
      return p && p.owner === tenant ? p.kind : null;
    },
    isFeedApplicant: async (key: ApplicantStageKey) => world.isMember(key),
    lockStage: async (key: ApplicantStageKey) => rows.get(id(key))?.stage ?? null,
    insertStage: async (
      key: ApplicantStageKey,
      stage: string,
      payerId: string,
      at: Date,
    ): Promise<boolean> => {
      if (rows.has(id(key))) return false;
      rows.set(id(key), { ...key, stage, actorPayerId: payerId, updatedAt: at });
      return true;
    },
    updateStage: async (key: ApplicantStageKey, stage: string, payerId: string, at: Date) => {
      const row = rows.get(id(key));
      if (row) rows.set(id(key), { ...row, stage, actorPayerId: payerId, updatedAt: at });
    },
    // NO ownership here, as in the real repository: the caller resolved the posting first.
    listPostingStages: async (
      postingKind: ApplicantPostingKind,
      postingId: string,
    ): Promise<StoredApplicantStage[]> =>
      [...rows.values()]
        .filter((r) => r.postingId === postingId && r.postingKind === postingKind)
        .map((r) => ({ workerId: r.workerId, stage: r.stage })),
  };
  return repo;
}
