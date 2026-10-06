/**
 * ADR-0050 — the agency-job V1 TWIN: one system-owned `job_postings` row per agency `jobs` row,
 * linked by `source_job_id`, written by ONE idempotent sync (#1957).
 *
 * THE SHARED CORE. The api's queue (event poll + periodic sweep) and the `db:sync:agency-twins`
 * CLI (`apps/api/src/agency-twin/sync-agency-twins.cli.ts`) both run exactly this code, so the twin a sweep writes and the twin the flip-window CLI
 * writes cannot differ. It holds:
 *
 *   - {@link planAgencyTwin}         — PURE: the target twin for one source row (§4.2).
 *   - {@link syncAgencyTwin}         — one job, one transaction: lock the source, diff, write
 *                                      only what changed, re-materialize `job_reach`, and hand
 *                                      the outcome to the caller's emitter INSIDE the transaction.
 *   - {@link disarmAgencyTwins}      — the kill switch's one action (§7).
 *   - {@link listAgencyJobIds}       — the sweep's keyset enumeration of agency jobs.
 *   - {@link materializeJobReachWithin} — the moment-③ statement on a caller's executor; the
 *                                      api's posting publish runs the same function.
 *
 * WHAT A TWIN IS NOT (the ADR's constraints, enforced here and by migration 0132's CHECKs):
 *   - never agent-owned: `payer_id` is NULL (C2, `job_postings_twin_owner_chk`);
 *   - never a guess: `match_skill_ids` is copied from the agency's EXPLICIT `jobs.match_skill_ids`
 *     and NEVER read from `trade_key` / `TRADE_TO_MATCH_SKILL` (C4);
 *   - never served while V1 is off: `draft` with `published_at` NULL (§4.2 step 1);
 *   - never written by anything but this module (§4.3 — every other writer refuses a twin).
 *
 * NO LLM, NO RANKING (§8): the status is a fixed precedence over the source row, the reach set is
 * `resolveReachSet` over the curated relations, and nothing here orders or hides a worker.
 */
import { resolveReachSet } from "@badabhai/match-engine";
import { workerVisibleTextScreens } from "@badabhai/validators";
import { isMatchSkillId, matchSkillIndustry } from "@badabhai/taxonomy";
import type { JobPostingStatus } from "@badabhai/types";
import { and, asc, eq, gt, inArray, sql as dsql } from "drizzle-orm";

import type { Database } from "./client";
import { screenJobTextForConversion } from "./match-v1-derive";
import { jobPostings, jobs, payers, type JobStatus } from "./schema";

/** The `job_postings.sync_source` value a twin carries (migration 0132's closed set). */
export const AGENCY_TWIN_SYNC_SOURCE = "agency_job" as const;

/** ADR-0050 Q4 — `jobs` has no vacancy count; D4's conservative band. */
export const AGENCY_TWIN_VACANCY_BAND = "1" as const;

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * THE Q3 BOOT CHECK — every reason the fixed system actor / neutral org label may not be stamped
 * on a twin, or `[]`. The api runs it when the sync module boots and the CLI before it writes, so
 * a bad edit to `@badabhai/config` fails closed instead of reaching a row. The label runs the SAME
 * worker-visible screens a posting's text runs (phone/email, company name, link): it is never
 * projected to a worker, but a faceless row must not gain employer identity either way.
 */
export function agencyTwinConstantsProblems(systemActorId: string, orgLabel: string): string[] {
  const problems: string[] = [];
  if (!UUID_SHAPE.test(systemActorId)) problems.push("the system actor id is not a uuid");
  if (orgLabel.trim().length === 0) problems.push("the org label is empty");
  const screens = workerVisibleTextScreens(orgLabel);
  if (screens.length > 0) problems.push(`the org label fails the screen(s): ${screens.join(", ")}`);
  return problems;
}

/** Why a twin may not serve. Mirrors `AGENCY_TWIN_REFUSED_REASONS` in @badabhai/event-schema. */
export type AgencyTwinRefusedReason =
  | "no_match_skills"
  | "unknown_match_skill"
  | "text_screen_failed"
  | "kill_switch";

/** What a write did. Mirrors `AGENCY_TWIN_SYNC_OPERATIONS` in @badabhai/event-schema. */
export type AgencyTwinOperation = "created" | "updated" | "status_changed" | "refused";

/**
 * The posting's changed-field KEYS (a subset of `JOB_POSTING_CHANGED_FIELDS` in
 * @badabhai/event-schema). One key per editorial unit, exactly as the posting routes report:
 * `pay_band` for both ends of the band, `experience` for both ends of the window, `match_skills`
 * for the match + reach set.
 */
export type AgencyTwinChangedField =
  | "org_label"
  | "role_title"
  | "description"
  | "vacancy_band"
  | "status"
  | "match_skills"
  | "city"
  | "pay_band"
  | "shift"
  | "needed_by"
  | "area"
  | "experience"
  | "pay_type"
  | "benefits"
  | "requirements"
  | "role_kind";

/** The agency `jobs` row the twin is derived from (only the columns the twin reads). */
export interface AgencyTwinSource {
  id: string;
  status: JobStatus;
  title: string;
  city: string;
  area: string | null;
  payMin: number | null;
  payMax: number | null;
  payType: string | null;
  shift: string | null;
  neededBy: string | null;
  description: string | null;
  minExperienceYears: number | null;
  maxExperienceYears: number | null;
  benefits: string[] | null;
  requirements: string[] | null;
  roleKind: string | null;
  matchSkillIds: string[];
  createdAt: Date;
}

/** What the caller decides once, outside any row: the deploy state and the Q3 constants. */
export interface AgencyTwinContext {
  /** MATCH_V1_ENABLED. Off ⇒ every twin is a pre-staged, unserved `draft`. */
  matchV1Enabled: boolean;
  /** `match_config.related_skills_default` — the same breadth the posting publish uses. */
  relatedSkillsDefault: "on" | "off";
  /** AGENCY_TWIN_SYSTEM_ACTOR_ID (@badabhai/config). Written at insert only. */
  systemActorId: string;
  /** AGENCY_TWIN_ORG_LABEL (@badabhai/config). Never projected to a worker. */
  orgLabel: string;
}

/** Every column the sync OWNS on a twin. Nothing outside this set is ever written by it. */
export interface AgencyTwinValues {
  orgLabel: string;
  roleTitle: string;
  city: string;
  area: string | null;
  payMin: number | null;
  payMax: number | null;
  payType: string | null;
  shift: string | null;
  neededBy: string | null;
  description: string | null;
  minExperienceYears: number | null;
  maxExperienceYears: number | null;
  benefits: string[] | null;
  requirements: string[] | null;
  roleKind: string | null;
  matchSkillIds: string[];
  reachSkillIds: string[];
  industryId: string | null;
  vacancyBand: typeof AGENCY_TWIN_VACANCY_BAND;
  status: JobPostingStatus;
  publishedAt: Date | null;
}

/** The planned twin, plus why it cannot serve (null when it can, or when V1 is off). */
export interface AgencyTwinPlan {
  values: AgencyTwinValues;
  refusedReason: Exclude<AgencyTwinRefusedReason, "kill_switch"> | null;
}

/**
 * Why an OPEN source cannot be served (§4.2 step 5), or null. Checked in this order so the
 * reported reason is deterministic: no pick, then a pick outside the active vocabulary, then the
 * worker-visible text screen (§8 — `role_title`, `description`, every chip; `city`/`area` follow
 * #1848 and are not screened here, as D4 does not screen them).
 */
function servabilityRefusal(
  source: AgencyTwinSource,
): Exclude<AgencyTwinRefusedReason, "kill_switch"> | null {
  if (source.matchSkillIds.length === 0) return "no_match_skills";
  if (source.matchSkillIds.some((id) => !isMatchSkillId(id))) return "unknown_match_skill";
  const failures = screenJobTextForConversion([
    {
      id: source.id,
      title: source.title,
      description: source.description,
      benefits: source.benefits,
      requirements: source.requirements,
    },
  ]);
  return failures.length > 0 ? "text_screen_failed" : null;
}

/**
 * PURE — the target twin for one agency `jobs` row (ADR-0050 §4.2).
 *
 * STATUS, in this precedence (§4.2):
 *   1. V1 off            → `draft`, `published_at` NULL (pre-staged, unserved);
 *   2. source `closed`   → `closed`;
 *   3. source `suspended`→ `suspended` (the ADR-0037 cascade moves the source; the twin follows);
 *   4. source `paused`   → `paused`;
 *   5. source `open` but unservable (no pick, unknown id, text screen) → `paused` + a reason;
 *   6. source `open`     → `open`.
 * `closed` only when the source closed, so a twin never needs `closed → open`; every "cannot
 * serve right now" state is the reversible `paused`.
 *
 * REACH. A refused twin carries NO match and NO reach (`[]`), so even a later status bug could not
 * serve it on a guessed or unscreened pick. Otherwise `match ∪ related(match)` through
 * `resolveReachSet` — the posting publish's own resolver — with no unticks (Q2).
 */
export function planAgencyTwin(source: AgencyTwinSource, ctx: AgencyTwinContext): AgencyTwinPlan {
  const refusal = servabilityRefusal(source);

  let status: JobPostingStatus;
  let refusedReason: AgencyTwinPlan["refusedReason"] = null;
  if (!ctx.matchV1Enabled) status = "draft";
  else if (source.status === "closed") status = "closed";
  else if (source.status === "suspended") status = "suspended";
  else if (source.status === "paused") status = "paused";
  else if (refusal !== null) {
    status = "paused";
    refusedReason = refusal;
  } else status = "open";

  // A pick that fails ANY servability rule is stored as nothing: the twin then reaches nobody
  // whatever its status, and a fixed pick re-derives everything on the next sync.
  const usable = refusal === null;
  const resolved = usable
    ? resolveReachSet({
        postedSkillIds: source.matchSkillIds,
        relatedDefault: ctx.relatedSkillsDefault,
        untickedIds: [],
      })
    : null;
  const matchSkillIds = resolved ? [...resolved.postedSkillIds] : [];
  const reachSkillIds = resolved ? [...resolved.reachSkillIds] : [];
  const firstSkill = matchSkillIds[0];

  return {
    refusedReason,
    values: {
      orgLabel: ctx.orgLabel,
      roleTitle: source.title,
      city: source.city,
      area: source.area,
      payMin: source.payMin,
      payMax: source.payMax,
      payType: source.payType,
      shift: source.shift,
      neededBy: source.neededBy,
      description: source.description,
      minExperienceYears: source.minExperienceYears,
      maxExperienceYears: source.maxExperienceYears,
      benefits: source.benefits,
      requirements: source.requirements,
      roleKind: source.roleKind,
      matchSkillIds,
      reachSkillIds,
      industryId: firstSkill === undefined ? null : (matchSkillIndustry(firstSkill) ?? null),
      vacancyBand: AGENCY_TWIN_VACANCY_BAND,
      status,
      // The honest visibility time (ADR-0049's #1649 order key) once V1 can serve the twin;
      // NULL while every twin is an unserved draft.
      publishedAt: ctx.matchV1Enabled ? source.createdAt : null,
    },
  };
}

const sameList = (a: readonly string[] | null, b: readonly string[] | null): boolean =>
  a === null || b === null ? a === b : a.length === b.length && a.every((v, i) => v === b[i]);

const sameTime = (a: Date | null, b: Date | null): boolean =>
  a === null || b === null ? a === b : a.getTime() === b.getTime();

/**
 * The changed KEYS between a stored twin and its plan, in a fixed order. Empty ⇔ nothing to
 * write. `published_at` rides `status` (it moves only with the V1 deploy state); `industry_id`
 * and `reach_skill_ids` ride `match_skills`.
 */
export function diffAgencyTwin(
  current: AgencyTwinValues,
  next: AgencyTwinValues,
): AgencyTwinChangedField[] {
  const changed: AgencyTwinChangedField[] = [];
  const push = (key: AgencyTwinChangedField, differs: boolean): void => {
    if (differs && !changed.includes(key)) changed.push(key);
  };
  push("org_label", current.orgLabel !== next.orgLabel);
  push("role_title", current.roleTitle !== next.roleTitle);
  push("description", current.description !== next.description);
  push("vacancy_band", current.vacancyBand !== next.vacancyBand);
  push("city", current.city !== next.city);
  push("area", current.area !== next.area);
  push("pay_band", current.payMin !== next.payMin || current.payMax !== next.payMax);
  push("pay_type", current.payType !== next.payType);
  push("shift", current.shift !== next.shift);
  push("needed_by", current.neededBy !== next.neededBy);
  push(
    "experience",
    current.minExperienceYears !== next.minExperienceYears ||
      current.maxExperienceYears !== next.maxExperienceYears,
  );
  push("benefits", !sameList(current.benefits, next.benefits));
  push("requirements", !sameList(current.requirements, next.requirements));
  push("role_kind", current.roleKind !== next.roleKind);
  push(
    "match_skills",
    !sameList(current.matchSkillIds, next.matchSkillIds) ||
      !sameList(current.reachSkillIds, next.reachSkillIds) ||
      current.industryId !== next.industryId,
  );
  push(
    "status",
    current.status !== next.status || !sameTime(current.publishedAt, next.publishedAt),
  );
  return changed;
}

/** The outcome of one `syncAgencyTwin` call. Ids and enums only — safe to log and to emit. */
export type AgencyTwinSyncOutcome =
  /** No agency job with that id (unknown, seed/ops row, or not an agent's). Nothing written. */
  | { kind: "not_agency_job"; sourceJobId: string }
  /**
   * A NON-twin posting already holds this `source_job_id` (a D4 conversion). The unique index
   * admits one posting per job, and a conversion is never repurposed. Nothing written.
   */
  | { kind: "blocked_by_conversion"; sourceJobId: string; jobPostingId: string }
  /** The stored twin already equals the plan. Nothing written, nothing emitted. */
  | { kind: "unchanged"; sourceJobId: string; jobPostingId: string; status: JobPostingStatus }
  /** The twin was (or, in a dry run, would be) written. */
  | {
      kind: "written";
      sourceJobId: string;
      /** Null only in a dry run of a twin that does not exist yet. */
      jobPostingId: string | null;
      operation: AgencyTwinOperation;
      status: JobPostingStatus;
      changedFields: AgencyTwinChangedField[];
      refusedReason: Exclude<AgencyTwinRefusedReason, "kill_switch"> | null;
    };

/** A written outcome with its id resolved — what the emitter receives inside the transaction. */
export type AgencyTwinWrite = Extract<AgencyTwinSyncOutcome, { kind: "written" }> & {
  jobPostingId: string;
};

/** Called INSIDE the sync's transaction, so a failed emit rolls the twin write back. */
export type AgencyTwinEmitter = (tx: Database, write: AgencyTwinWrite) => Promise<void>;

/** The twin columns as a {@link AgencyTwinValues} (jsonb arrays narrowed defensively). */
function storedValues(row: typeof jobPostings.$inferSelect): AgencyTwinValues {
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    orgLabel: row.orgLabel,
    roleTitle: row.roleTitle,
    city: row.city ?? "",
    area: row.area,
    payMin: row.payMin,
    payMax: row.payMax,
    payType: row.payType,
    shift: row.shift,
    neededBy: row.neededBy,
    description: row.description,
    minExperienceYears: row.minExperienceYears,
    maxExperienceYears: row.maxExperienceYears,
    benefits: row.benefits === null ? null : strings(row.benefits),
    requirements: row.requirements === null ? null : strings(row.requirements),
    roleKind: row.roleKind,
    matchSkillIds: strings(row.matchSkillIds),
    reachSkillIds: strings(row.reachSkillIds),
    industryId: row.industryId,
    vacancyBand: row.vacancyBand as typeof AGENCY_TWIN_VACANCY_BAND,
    status: row.status,
    publishedAt: row.publishedAt,
  };
}

/** The "no twin yet" baseline, so a create reports every populated key it writes. */
const EMPTY_VALUES: AgencyTwinValues = {
  orgLabel: "",
  roleTitle: "",
  city: "",
  area: null,
  payMin: null,
  payMax: null,
  payType: null,
  shift: null,
  neededBy: null,
  description: null,
  minExperienceYears: null,
  maxExperienceYears: null,
  benefits: null,
  requirements: null,
  roleKind: null,
  matchSkillIds: [],
  reachSkillIds: [],
  industryId: null,
  vacancyBand: AGENCY_TWIN_VACANCY_BAND,
  status: "draft",
  publishedAt: null,
};

/** The drizzle column set for a twin write (the sync-owned columns only). */
function columnsOf(v: AgencyTwinValues) {
  return {
    orgLabel: v.orgLabel,
    roleTitle: v.roleTitle,
    city: v.city,
    area: v.area,
    payMin: v.payMin,
    payMax: v.payMax,
    payType: v.payType as (typeof jobPostings.$inferInsert)["payType"],
    shift: v.shift as (typeof jobPostings.$inferInsert)["shift"],
    neededBy: v.neededBy as (typeof jobPostings.$inferInsert)["neededBy"],
    description: v.description,
    minExperienceYears: v.minExperienceYears,
    maxExperienceYears: v.maxExperienceYears,
    benefits: v.benefits,
    requirements: v.requirements,
    roleKind: v.roleKind as (typeof jobPostings.$inferInsert)["roleKind"],
    matchSkillIds: v.matchSkillIds,
    reachSkillIds: v.reachSkillIds,
    industryId: v.industryId,
    vacancyBand: v.vacancyBand,
    status: v.status,
    publishedAt: v.publishedAt,
  };
}

/** `job_reach` is kept only for a LIVE twin (open/paused — the reconcile's own scope). */
const isLive = (status: JobPostingStatus): boolean => status === "open" || status === "paused";

/**
 * MOMENT ③ on a caller's executor — materialize one posting's ENTIRE reach set from its stored
 * posted + reach ids, and delete the rows the set no longer qualifies. The statement the api's
 * `WorkerSkillsRepository.materializeReachForPosting` runs (it delegates here), and the shape
 * D5 (`materialize-job-reach.ts`) runs per posting: `MIN(CASE …)` is best-tier-wins (E6) and
 * `ARRAY_AGG(… ORDER BY direct DESC, months DESC)[1]` names the skill that achieved the tier.
 * An empty reach set clears the posting's rows.
 */
export async function materializeJobReachWithin(
  executor: Database,
  jobPostingId: string,
  postedSkillIds: readonly string[],
  reachSkillIds: readonly string[],
): Promise<void> {
  if (reachSkillIds.length === 0) {
    await executor.execute(
      dsql`DELETE FROM job_reach WHERE job_posting_id = ${jobPostingId}::uuid`,
    );
    return;
  }
  const posted = dsql.param([...postedSkillIds]);
  const reach = dsql.param([...reachSkillIds]);

  await executor.execute(dsql`
    INSERT INTO job_reach (job_posting_id, worker_id, match_tier, matched_skill_id)
    SELECT ${jobPostingId}::uuid,
           ws.worker_id,
           MIN(CASE WHEN ws.skill_id = ANY(${posted}::text[]) THEN 1 ELSE 2 END),
           (ARRAY_AGG(ws.skill_id ORDER BY (ws.skill_id = ANY(${posted}::text[])) DESC,
                                           ws.months_bucketed DESC))[1]
    FROM worker_skill ws
    WHERE ws.skill_id = ANY(${reach}::text[]) AND ws.wants
    GROUP BY ws.worker_id
    ON CONFLICT (job_posting_id, worker_id) DO UPDATE
      SET match_tier       = EXCLUDED.match_tier,
          matched_skill_id = EXCLUDED.matched_skill_id,
          computed_at      = now()
  `);

  await executor.execute(dsql`
    DELETE FROM job_reach jr
    WHERE jr.job_posting_id = ${jobPostingId}::uuid
      AND NOT EXISTS (
        SELECT 1 FROM worker_skill ws
        WHERE ws.worker_id = jr.worker_id
          AND ws.skill_id = ANY(${reach}::text[])
          AND ws.wants
      )
  `);
}

/** The source columns the twin reads, joined to its AGENT owner (the agency scope, §5). */
function agencySourceQuery(executor: Database, jobId: string) {
  return executor
    .select({
      id: jobs.id,
      status: jobs.status,
      title: jobs.title,
      city: jobs.city,
      area: jobs.area,
      payMin: jobs.payMin,
      payMax: jobs.payMax,
      payType: jobs.payType,
      shift: jobs.shift,
      neededBy: jobs.neededBy,
      description: jobs.description,
      minExperienceYears: jobs.minExperienceYears,
      maxExperienceYears: jobs.maxExperienceYears,
      benefits: jobs.benefits,
      requirements: jobs.requirements,
      roleKind: jobs.roleKind,
      matchSkillIds: jobs.matchSkillIds,
      createdAt: jobs.createdAt,
    })
    .from(jobs)
    .innerJoin(payers, eq(payers.id, jobs.payerId))
    .where(and(eq(jobs.id, jobId), eq(payers.role, "agent")))
    .limit(1);
}

function toSource(row: Awaited<ReturnType<typeof agencySourceQuery>>[number]): AgencyTwinSource {
  return {
    ...row,
    payType: row.payType,
    shift: row.shift,
    neededBy: row.neededBy,
    roleKind: row.roleKind,
    matchSkillIds: Array.isArray(row.matchSkillIds)
      ? row.matchSkillIds.filter((x): x is string => typeof x === "string")
      : [],
  };
}

/**
 * Which operation a write is (§9). A REFUSAL WINS, including on the write that creates the twin:
 * `job_posting.twin_synced` admits a `refused_reason` only with `operation: "refused"` (and only
 * on a `paused` twin), so a twin born unservable — an open agency job with no pick yet — is
 * reported as `refused`, never as a `created` that carries a reason. `changed_fields` still
 * lists every key the create populated.
 */
export function agencyTwinOperation(
  created: boolean,
  changed: readonly AgencyTwinChangedField[],
  refusedReason: AgencyTwinPlan["refusedReason"],
): AgencyTwinOperation {
  if (refusedReason !== null) return "refused";
  if (created) return "created";
  return changed.length === 1 && changed[0] === "status" ? "status_changed" : "updated";
}

/**
 * ONE JOB, ONE TRANSACTION (ADR-0050 §5). Idempotent and state-based: it reads the COMMITTED
 * source row and converges the twin to {@link planAgencyTwin}, so running it twice, late, or after
 * a missed trigger writes the same row — and an unchanged source writes and emits NOTHING.
 *
 *   1. Lock the source `jobs` row (`FOR UPDATE OF jobs`), so two syncs of one job serialize.
 *   2. Read the posting holding this `source_job_id`. A non-twin there (a D4 conversion) blocks.
 *   3. Plan; diff against the stored twin; write ONLY when a synced column differs — the whole
 *      sync-owned column set in one statement, never a partial field write.
 *   4. When the match set or the status moved, re-materialize the twin's `job_reach` in the same
 *      transaction (live twins only; a non-live twin's rows are cleared).
 *   5. Hand the outcome to `emit` on the same transaction: a failed emit rolls the write back,
 *      and the next sync retries both.
 *
 * `apply: false` is a DRY RUN: no lock, no write, no emit — the outcome says what WOULD happen.
 * A DB error propagates and rolls back this job only; the caller moves on to the next job.
 */
export async function syncAgencyTwin(
  db: Database,
  jobId: string,
  ctx: AgencyTwinContext,
  options: { apply: boolean; emit?: AgencyTwinEmitter },
): Promise<AgencyTwinSyncOutcome> {
  const run = async (executor: Database): Promise<AgencyTwinSyncOutcome> => {
    const query = agencySourceQuery(executor, jobId);
    const [sourceRow] = options.apply ? await query.for("update", { of: jobs }) : await query;
    if (!sourceRow) return { kind: "not_agency_job", sourceJobId: jobId };
    const source = toSource(sourceRow);

    const [existing] = await executor
      .select()
      .from(jobPostings)
      .where(eq(jobPostings.sourceJobId, jobId))
      .limit(1);
    if (existing && existing.syncSource !== AGENCY_TWIN_SYNC_SOURCE) {
      return { kind: "blocked_by_conversion", sourceJobId: jobId, jobPostingId: existing.id };
    }

    const plan = planAgencyTwin(source, ctx);
    // A create reports every key it populates (diffed against an empty twin).
    const changed = diffAgencyTwin(existing ? storedValues(existing) : EMPTY_VALUES, plan.values);
    if (existing && changed.length === 0) {
      return {
        kind: "unchanged",
        sourceJobId: jobId,
        jobPostingId: existing.id,
        status: existing.status,
      };
    }

    const write = {
      kind: "written" as const,
      sourceJobId: jobId,
      operation: agencyTwinOperation(!existing, changed, plan.refusedReason),
      status: plan.values.status,
      changedFields: changed,
      refusedReason: plan.refusedReason,
    };
    if (!options.apply) return { ...write, jobPostingId: existing?.id ?? null };

    const now = new Date();
    let jobPostingId: string;
    if (existing) {
      await executor
        .update(jobPostings)
        .set({ ...columnsOf(plan.values), updatedAt: now })
        .where(
          and(eq(jobPostings.id, existing.id), eq(jobPostings.syncSource, AGENCY_TWIN_SYNC_SOURCE)),
        );
      jobPostingId = existing.id;
    } else {
      const [inserted] = await executor
        .insert(jobPostings)
        .values({
          ...columnsOf(plan.values),
          createdBy: ctx.systemActorId,
          payerId: null,
          sourceJobId: jobId,
          syncSource: AGENCY_TWIN_SYNC_SOURCE,
          updatedAt: now,
        })
        .returning({ id: jobPostings.id });
      if (!inserted) throw new Error("agency twin insert returned no row");
      jobPostingId = inserted.id;
    }

    if (changed.includes("match_skills") || changed.includes("status")) {
      const live = isLive(plan.values.status);
      await materializeJobReachWithin(
        executor,
        jobPostingId,
        live ? plan.values.matchSkillIds : [],
        live ? plan.values.reachSkillIds : [],
      );
    }

    const result: AgencyTwinWrite = { ...write, jobPostingId };
    if (options.emit) await options.emit(executor, result);
    return result;
  };

  if (!options.apply) return run(db);
  return db.transaction(async (tx) => run(tx as unknown as Database));
}

/** One twin the kill switch moved. */
export interface AgencyTwinDisarmed {
  jobPostingId: string;
  sourceJobId: string;
}

/**
 * THE KILL SWITCH (ADR-0050 §7) — the disarmed sync's ONE action. Drives up to `limit` non-closed,
 * non-paused twins to `paused` in ONE bounded statement and copies NO field: disarming removes
 * agency inventory from the V1 deck and stops a buggy sync writing content. Each moved twin's
 * `job_reach` rows stay (the reconcile keeps `paused` warm); the feed's `status = 'open'` hides it.
 * `emit` runs per moved twin inside the same transaction. Re-arming restores every twin to its
 * mirrored status on the next sweep. Returns the moved twins (empty when none are left).
 */
export async function disarmAgencyTwins(
  db: Database,
  limit: number,
  emit?: (tx: Database, moved: AgencyTwinDisarmed) => Promise<void>,
): Promise<AgencyTwinDisarmed[]> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    const rows = await tx.execute<{ id: string; source_job_id: string }>(dsql`
      WITH due AS (
        SELECT id
        FROM job_postings
        WHERE sync_source = ${AGENCY_TWIN_SYNC_SOURCE}
          AND status NOT IN ('closed', 'paused')
        ORDER BY id
        LIMIT ${limit}
        FOR UPDATE
      )
      UPDATE job_postings jp
      SET status = 'paused', updated_at = now()
      FROM due
      WHERE jp.id = due.id
      RETURNING jp.id, jp.source_job_id
    `);
    const moved = (rows as unknown as { id: string; source_job_id: string }[]).map((r) => ({
      jobPostingId: r.id,
      sourceJobId: r.source_job_id,
    }));
    if (emit) for (const m of moved) await emit(tx, m);
    return moved;
  });
}

/**
 * The sweep's keyset page of AGENCY job ids (owner `role = 'agent'`), ascending, after
 * `afterId`. Every status: a closed or suspended source still has a twin to converge.
 */
export async function listAgencyJobIds(
  db: Database,
  afterId: string | null,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .innerJoin(payers, eq(payers.id, jobs.payerId))
    .where(
      afterId === null
        ? eq(payers.role, "agent")
        : and(eq(payers.role, "agent"), gt(jobs.id, afterId)),
    )
    .orderBy(asc(jobs.id))
    .limit(limit);
  return rows.map((r) => r.id);
}

/**
 * Of `jobIds`, the AGENCY ones — used by the event poll, which reads `job.*` subjects that may be
 * seed/ops rows too. One indexed probe.
 */
export async function filterAgencyJobIds(
  db: Database,
  jobIds: readonly string[],
): Promise<string[]> {
  if (jobIds.length === 0) return [];
  const rows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .innerJoin(payers, eq(payers.id, jobs.payerId))
    .where(and(inArray(jobs.id, [...jobIds]), eq(payers.role, "agent")));
  return rows.map((r) => r.id);
}

/**
 * THE D4 FENCE (ADR-0050 §6.2, C6) — split D4's open `jobs` rows. Only `payer_id` NULL rows
 * (seed/ops) are convertible. Every payer-owned row is agency inventory: reported, NEVER
 * converted, and D4's `--apply` is refused while any of them has no twin yet.
 */
export function d4AgencyFence<T extends { id: string; payerId: string | null }>(
  openJobs: readonly T[],
  twinnedSourceIds: ReadonlySet<string>,
): { convertible: T[]; agencyRows: T[]; agencyRowsWithoutTwin: T[] } {
  const convertible = openJobs.filter((j) => j.payerId === null);
  const agencyRows = openJobs.filter((j) => j.payerId !== null);
  return {
    convertible,
    agencyRows,
    agencyRowsWithoutTwin: agencyRows.filter((j) => !twinnedSourceIds.has(j.id)),
  };
}
