/**
 * #2754 item 7 — each live Campus job becomes a BadaBhai posting of its moved company.
 *
 * THE SAME CREATOR AS CAMPUS'S "POST FOR A COMPANY" (#2752 item 5): `createForCampus`, with the hold
 * origin `campus_imported` (#2891). It writes the posting as a draft, holds it from BadaBhai
 * workers while it is still a draft, then opens it; its audience is `both` (ruling 17 Nov 2026:
 * RVM students, and BadaBhai workers once an admin turns the job's visibility on). The import
 * then records the RVM approval as the Campus route does (`approveAsCreated`): the job was live
 * for students on Campus already. What `postForCompany` does around that call, the import does
 * here too (#2891's list, 17 Nov):
 *   - the posting's fields are validated by the company form's own schema FIRST
 *     (`PayerCreateJobPostingSchema`); an optional field it refuses is dropped and recorded, a
 *     refused title or company name is an exception;
 *   - the owner is the company's TENANT key, and a company that joined another employer's org is
 *     refused rather than making that employer the owner;
 *   - branch targeting keeps only ACTIVE options (`rvm_targeting_options`); unknown ids are dropped
 *     and counted. Bundle v1 has no course targeting;
 *   - only active, unexpired jobs are imported, so every posting may end open;
 *   - the approval's reviewer ref is the batch id (a uuid), so the review says who approved it: the
 *     import batch, as Campus had.
 *
 * NOT IDEMPOTENT ON ITS OWN: each `createForCampus` call is a new posting. So the ledger row is
 * RESERVED (`held`, reason `creating`) in its own transaction BEFORE the call, and a later run that
 * finds a reservation never creates again: it reports `interrupted_creation` for a person to check
 * (the posting may or may not exist).
 *
 * THE HOLD IS CHECKED, NOT ASSUMED. After each create the import reads the posting's
 * `job_posting_worker_visibility` row. A posting with no `off` row would be open to every BadaBhai
 * worker at once, so it is closed on the spot and the whole jobs step stops.
 *
 * `role_kind` is not set: Campus job roles do not map to the 16 trades by any rule yet, and a
 * guess would put a posting in the wrong trade. An admin sets the trade when turning a job on.
 */
import { sql } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import type { RequestContext } from "../../common/request-context";
import {
  PayerCreateJobPostingSchema,
  type PayerCreateJobPostingDto,
} from "../../job-postings/job-postings.dto";
import type { PayerTenantScope, TenantKey } from "../payer-tenant-scope";
import type { CampusBundle, CampusCompany, CampusJob } from "./bundle.schema";
import { decideJob } from "./mapping";
import { lockRow, writeRow, FINISHED_STATES, type OpenBatch } from "./import-ledger.repository";

/** `createForCampus` with the #2891 hold origin (#2903). */
export interface CampusPostingCreator {
  createForCampus(
    scope: PayerTenantScope,
    dto: PayerCreateJobPostingDto,
    targeting: { rvm_branch_ids: number[]; rvm_course_ids: string[] },
    ctx: RequestContext,
    opts: { origin: "campus_imported" },
  ): Promise<{ id: string }>;
}

export interface JobImportDeps {
  db: Database;
  creator: CampusPostingCreator;
  /** The company's tenant scope, as `CampusPostingsService.ownerScope` resolves it. */
  ownerScope: (companyId: string) => Promise<PayerTenantScope>;
  /** The ACTIVE branch refs among `refs` (`PostingAudienceRepository.activeOptionRefs`). */
  activeBranchRefs: (refs: readonly string[]) => Promise<Set<string>>;
  /** Record the RVM approval, as the Campus route does (`CampusPostingsRepository.approveAsCreated`). */
  approve: (tx: Database, jobPostingId: string, reviewerRef: string) => Promise<void>;
  /** Close a posting that came out unheld (`JobPostingsRepository.transitionOwned` open → closed). */
  close: (jobPostingId: string, tenant: TenantKey) => Promise<void>;
  /** Does the posting hold an `off` worker-visibility row (#2891)? The wiring reads the table. */
  isHeld: (jobPostingId: string) => Promise<boolean>;
}

export interface JobImportSummary {
  created: number;
  alreadyDone: number;
  notMoved: Record<string, number>;
  /** Optional fields the company form refused, dropped from the posting, by field. */
  droppedFields: Record<string, number>;
  /** Branch ids that are not active targeting options, dropped. */
  droppedBranchIds: number;
  /** Campus job source id → BadaBhai posting id, for every imported job (this run or earlier). */
  placed: Map<string, string>;
}

export class UnheldPostingError extends Error {
  constructor(readonly jobPostingId: string) {
    super(`posting ${jobPostingId} has no worker-visibility hold; it was closed and the jobs step stopped`);
    this.name = "UnheldPostingError";
  }
}

const bump = (tally: Record<string, number>, key: string): void => {
  tally[key] = (tally[key] ?? 0) + 1;
};

/** Campus LPA (annual, lakhs) to BadaBhai's monthly whole rupees. */
export function lpaToMonthlyInr(lpa: number | null): number | undefined {
  if (lpa === null || !Number.isFinite(lpa) || lpa <= 0) return undefined;
  return Math.round((lpa * 100_000) / 12);
}

const OPTIONAL_FIELDS = [
  "description",
  "location_label",
  "city",
  "pay_min",
  "pay_max",
  "pay_type",
  "min_experience_years",
  "max_experience_years",
] as const;

export type PostingDtoResult =
  | { ok: true; dto: PayerCreateJobPostingDto; dropped: string[] }
  | { ok: false; reason: string };

/**
 * The company form's fields for one Campus job, validated by `PayerCreateJobPostingSchema`. An
 * optional field the schema refuses (a phone in a description, a place it will not show) is
 * dropped and named in `dropped`; a refused required field is a reason, never a guess.
 */
export function buildPostingDto(job: CampusJob, company: CampusCompany): PostingDtoResult {
  const location = job.location?.trim() || null;
  const payMin = lpaToMonthlyInr(job.salary_min_lpa);
  const payMax = lpaToMonthlyInr(job.salary_max_lpa);
  const minYears = job.experience_min_months === null ? undefined : Math.floor(job.experience_min_months / 12);
  const maxYears = job.experience_max_months === null ? undefined : Math.ceil(job.experience_max_months / 12);
  const raw: Record<string, unknown> = {
    org_label: company.name.trim(),
    role_title: job.title.trim(),
    vacancies: job.openings !== null && job.openings > 0 ? job.openings : 1,
    description: job.description?.trim() || undefined,
    location_label: location ?? undefined,
    city: location !== null && location.length <= 80 ? location : undefined,
    pay_min: payMin,
    pay_max: payMax,
    pay_type: payMin !== undefined || payMax !== undefined ? "ctc" : undefined,
    min_experience_years: minYears,
    max_experience_years: maxYears,
  };
  const dropped: string[] = [];
  for (let attempt = 0; attempt <= OPTIONAL_FIELDS.length; attempt += 1) {
    const parsed = PayerCreateJobPostingSchema.safeParse(raw);
    if (parsed.success) return { ok: true, dto: parsed.data, dropped };
    const paths = new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "")));
    const optional = OPTIONAL_FIELDS.filter((f) => paths.has(f) && raw[f] !== undefined);
    if (optional.length === 0) {
      const first = [...paths][0] || "record";
      return { ok: false, reason: `job_invalid_${first}`.slice(0, 64) };
    }
    for (const f of optional) {
      raw[f] = undefined;
      dropped.push(f);
    }
    // A pay band loses both ends together, and its type with them.
    if (optional.some((f) => f.startsWith("pay_"))) {
      for (const f of ["pay_min", "pay_max", "pay_type"] as const) {
        if (raw[f] !== undefined) {
          raw[f] = undefined;
          dropped.push(f);
        }
      }
    }
    if (optional.some((f) => f.endsWith("_experience_years"))) {
      for (const f of ["min_experience_years", "max_experience_years"] as const) {
        if (raw[f] !== undefined) {
          raw[f] = undefined;
          dropped.push(f);
        }
      }
    }
  }
  return { ok: false, reason: "job_invalid_record" };
}

/** True when the posting holds an `off` worker-visibility row (#2891). */
export async function postingIsHeld(db: Database, jobPostingId: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM job_posting_worker_visibility
       WHERE job_posting_id = ${jobPostingId}::uuid AND state = 'off'
    ) AS held`)) as unknown as { held: boolean }[];
  return rows[0]?.held === true;
}

/** Is #2891's hold table present? The CLI imports no job without it. */
export async function workerVisibilityTableExists(db: Database): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT to_regclass('public.job_posting_worker_visibility') IS NOT NULL AS ok`)) as unknown as {
    ok: boolean;
  }[];
  return rows[0]?.ok === true;
}

export async function importJobs(
  deps: JobImportDeps,
  batch: OpenBatch,
  bundle: CampusBundle,
  placedCompanies: ReadonlyMap<string, string>,
  ctx: RequestContext,
): Promise<JobImportSummary> {
  const summary: JobImportSummary = {
    created: 0,
    alreadyDone: 0,
    notMoved: {},
    droppedFields: {},
    droppedBranchIds: 0,
    placed: new Map(),
  };
  const companies = new Map(bundle.companies.map((c) => [c.source_id, c]));

  for (const job of bundle.jobs) {
    // 1. Reserve the record, or find it done, under its lock.
    const step = await deps.db.transaction(async (raw) => {
      const tx = raw as unknown as Database;
      const prior = await lockRow(tx, "job", job.source_id);
      if (prior && FINISHED_STATES.has(prior.state)) {
        return { kind: "done" as const, postingId: prior.targetId! };
      }
      const skip = async (state: "skipped" | "exception", reason: string, detail: Record<string, unknown> = {}) => {
        await writeRow(tx, {
          batchId: batch.id,
          kind: "job",
          sourceId: job.source_id,
          companySourceId: job.company_source_id,
          state,
          targetId: null,
          reason,
          detail,
        });
        return { kind: "not_moved" as const, reason };
      };
      // A reservation that never finished, or one already reported, stays put until a person
      // has checked whether its posting exists: the import never creates a second one.
      if (prior?.reason === "creating" || prior?.reason === "interrupted_creation") {
        if (prior.reason === "creating") await skip("exception", "interrupted_creation");
        return { kind: "not_moved" as const, reason: "interrupted_creation" };
      }
      const decision = decideJob(job);
      if (!decision.move) return skip("skipped", decision.reason);
      const companyId = placedCompanies.get(job.company_source_id);
      if (companyId === undefined) return skip("skipped", "company_not_placed");
      await writeRow(tx, {
        batchId: batch.id,
        kind: "job",
        sourceId: job.source_id,
        companySourceId: job.company_source_id,
        state: "held",
        targetId: null,
        reason: "creating",
        detail: {},
      });
      return { kind: "reserved" as const, companyId };
    });
    if (step.kind === "done") {
      summary.alreadyDone += 1;
      summary.placed.set(job.source_id, step.postingId);
      continue;
    }
    if (step.kind === "not_moved") {
      bump(summary.notMoved, step.reason);
      continue;
    }

    // 2. Everything that can refuse, before anything is created.
    const finishWithout = async (reason: string, detail: Record<string, unknown> = {}) => {
      await deps.db.transaction(async (raw) => {
        await writeRow(raw as unknown as Database, {
          batchId: batch.id,
          kind: "job",
          sourceId: job.source_id,
          companySourceId: job.company_source_id,
          state: "exception",
          targetId: null,
          reason,
          detail,
        });
      });
      bump(summary.notMoved, reason);
    };
    const scope = await deps.ownerScope(step.companyId);
    if (scope.tenantKey !== step.companyId) {
      await finishWithout("company_in_another_org");
      continue;
    }
    const built = buildPostingDto(job, companies.get(job.company_source_id)!);
    if (!built.ok) {
      await finishWithout(built.reason);
      continue;
    }
    const branchRefs = ((job.audience as { allowed_location_ids?: unknown }).allowed_location_ids ?? []) as unknown[];
    const wanted = branchRefs.filter((r): r is number => Number.isInteger(r)).map(String);
    const active = await deps.activeBranchRefs(wanted);
    const branchIds = wanted.filter((r) => active.has(r)).map(Number);
    const droppedBranches = wanted.length - branchIds.length;

    // 3. Create, check the hold, approve and finish the ledger row. A failure inside the creator
    // may leave a draft behind (it opens the draft in a second step), so it is recorded as an
    // interrupted creation for a person to check, never retried blind.
    let posting: { id: string };
    try {
      posting = await deps.creator.createForCampus(
        scope,
        built.dto,
        { rvm_branch_ids: branchIds, rvm_course_ids: [] },
        ctx,
        { origin: "campus_imported" },
      );
    } catch (err) {
      await finishWithout("interrupted_creation", {
        error: err instanceof Error ? err.name : "unknown",
      });
      continue;
    }
    if (!(await deps.isHeld(posting.id))) {
      await deps.close(posting.id, scope.tenantKey);
      await finishWithout("posting_not_held_closed", { posting_id: posting.id });
      throw new UnheldPostingError(posting.id);
    }
    await deps.db.transaction(async (raw) => {
      const tx = raw as unknown as Database;
      await deps.approve(tx, posting.id, batch.id);
      await writeRow(tx, {
        batchId: batch.id,
        kind: "job",
        sourceId: job.source_id,
        companySourceId: job.company_source_id,
        state: "created",
        targetId: posting.id,
        reason: null,
        detail: {
          campus_created_at: job.created_at,
          dropped_fields: built.dropped,
          branch_ids: branchIds.length,
          dropped_branch_ids: droppedBranches,
          role_kind: "not_set",
        },
      });
    });
    for (const f of built.dropped) bump(summary.droppedFields, f);
    summary.droppedBranchIds += droppedBranches;
    summary.created += 1;
    summary.placed.set(job.source_id, posting.id);
  }
  return summary;
}
