import { Inject, Injectable } from "@nestjs/common";
import { and, inArray, desc, eq, ne } from "drizzle-orm";
import {
  type Database,
  jobs,
  payers,
  type Job,
  type NewJob,
  type JobStatus,
  type TradeKey,
  type JobNeededBy,
  type JobShift,
  type JobPayType,
} from "@badabhai/db";
import type { TradeFormKindName } from "@badabhai/types";
import { DATABASE } from "../database/database.module";
import type { TenantKey } from "../payers/payer-tenant-scope";

/**
 * The patch shape for an agency job edit — coarse, non-PII columns only, plus the
 * DTO-screened worker-visible content columns (description/shift/benefits/requirements,
 * ADR-0024 final addendum — free text is guarded fail-closed at the DTO boundary before
 * it can reach this patch). `updatedAt` is always set by the service. Excludes `id`,
 * `payerId`, `createdAt` (immutable / owner).
 */
export type AgencyJobUpdate = Partial<
  Pick<
    NewJob,
    | "tradeKey"
    | "title"
    | "city"
    | "area"
    | "payMin"
    | "payMax"
    | "minExperienceYears"
    | "maxExperienceYears"
    | "neededBy"
    | "description"
    | "shift"
    | "benefits"
    | "requirements"
    // #1648 — what the ₹ band MEANS (in_hand | gross | ctc). Coarse, closed, non-PII.
    | "payType"
    // Migration 0131 — the display role (one of the 21 declared kinds). Closed, non-PII.
    | "roleKind"
    // ADR-0050 C4 — the explicit `mskill_*` pick, already validated against
    // the closed vocabulary and the cap by the service. `[]` = "not chosen yet".
    | "matchSkillIds"
    | "status"
  >
> & { updatedAt: Date };

/**
 * Input for creating an owned job. `payerId` is the resolved TENANT KEY (ADR-0053 §5.2 rule 3):
 * the session payer while org tenancy is off, the acting org's anchor when on — stamped
 * server-side, never a body value.
 */
export interface CreateAgencyJobInput {
  payerId: TenantKey;
  tradeKey: TradeKey;
  title: string;
  city: string;
  area: string | null;
  payMin: number | null;
  payMax: number | null;
  minExperienceYears: number | null;
  maxExperienceYears: number | null;
  neededBy: JobNeededBy | null;
  // Worker-visible content (ADR-0024 final addendum) — already screened at the DTO
  // boundary (looksLikePii + looksLikeOrgName, fail-closed) before reaching here.
  description: string | null;
  shift: JobShift | null;
  benefits: string[] | null;
  requirements: string[] | null;
  /** #1648 — NULL means the poster did not state it. There is no default anywhere. */
  payType: JobPayType | null;
  /** Migration 0131 — the display role, or NULL ("no role picked"). Never a match input. */
  roleKind: TradeFormKindName | null;
  /** ADR-0050 C4 — validated `mskill_*` ids, or `[]` ("not chosen yet"). */
  matchSkillIds: string[];
}

/**
 * Data access for the `jobs` ENTITY write path (ADR-0022 — the FIRST jobs-write service;
 * distinct from `job_postings`). Every read is OWNER-SCOPED: an `:jobId` is always fetched
 * with the TENANT KEY in the WHERE so a cross-tenant row is never even returned (the
 * app-layer tenant chokepoint, defense-in-depth with the row's `payer_id` re-check via
 * `readOwnedById`/`assertOwnedRows` in the service). The key is the branded `TenantKey`
 * only the resolver mints (ADR-0053). NO PII columns exist on `jobs`.
 */
@Injectable()
export class AgencyJobsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Create an owned job (status forced to 'open' by the service via the input). */
  async create(input: CreateAgencyJobInput, status: JobStatus): Promise<Job> {
    const [row] = await this.db
      .insert(jobs)
      .values({
        payerId: input.payerId,
        tradeKey: input.tradeKey,
        title: input.title,
        city: input.city,
        area: input.area,
        payMin: input.payMin,
        payMax: input.payMax,
        minExperienceYears: input.minExperienceYears,
        maxExperienceYears: input.maxExperienceYears,
        neededBy: input.neededBy,
        description: input.description,
        shift: input.shift,
        benefits: input.benefits,
        requirements: input.requirements,
        payType: input.payType,
        roleKind: input.roleKind,
        matchSkillIds: input.matchSkillIds,
        status,
      })
      .returning();
    if (!row) throw new Error("failed to create job");
    return row;
  }

  /**
   * Fetch a job by id, OWNER-SCOPED (tenant in the WHERE). Returns undefined for both an
   * unknown id and another tenant's job — so the service surfaces the IDENTICAL neutral 404
   * (no-oracle). The service additionally re-asserts ownership via `readOwnedById`.
   */
  async findOwnedById(jobId: string, tenant: TenantKey): Promise<Job | undefined> {
    const [row] = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, jobId), eq(jobs.payerId, tenant)))
      .limit(1);
    return row;
  }

  /** List the tenant's OWN jobs, newest first. Full rows; the service projects facelessly. */
  async listOwned(tenant: TenantKey): Promise<Job[]> {
    return this.db
      .select()
      .from(jobs)
      .where(eq(jobs.payerId, tenant))
      .orderBy(desc(jobs.createdAt));
  }

  /**
   * Apply a patch to an OWNED job (tenant in the WHERE — a cross-tenant id updates nothing
   * and returns undefined). Returns the updated row or undefined if no owned row matched.
   */
  async updateOwned(
    jobId: string,
    tenant: TenantKey,
    patch: AgencyJobUpdate,
  ): Promise<Job | undefined> {
    const [row] = await this.db
      .update(jobs)
      .set(patch)
      .where(and(eq(jobs.id, jobId), eq(jobs.payerId, tenant)))
      .returning();
    return row;
  }

  /**
   * Close an OWNED job that is currently LIVE — `open` OR `paused` (#1202).
   *
   * The paused arm is not a nicety: before #1202 pause wrote `closed`, so "close" only ever
   * had to accept `open`. Now that a pause is reversible, a job can sit in `paused`, and a
   * close guarded on `open` alone would strand it there permanently — the owner could resume
   * it but never close it.
   *
   * `suspended` is deliberately NOT closable through this path: it is SYSTEM-owned
   * (ADR-0037) and only the reinstate cascade may move it.
   *
   * Tenant + the expected from-states are both in the WHERE, so a concurrent transition (or a
   * cross-tenant id) updates nothing and returns undefined — the service maps that to the
   * right response without a second read.
   */
  async closeOwnedIfLive(jobId: string, tenant: TenantKey, now: Date): Promise<Job | undefined> {
    const [row] = await this.db
      .update(jobs)
      .set({ status: "closed", updatedAt: now })
      .where(
        and(
          eq(jobs.id, jobId),
          eq(jobs.payerId, tenant),
          inArray(jobs.status, ["open", "paused"]),
        ),
      )
      .returning();
    return row;
  }

  /**
   * PAUSE an OWNED job: `open -> paused` (#1202). Reversible, and the exact transition the
   * Payer App's Pause button always claimed to make — before #1202 it wrote `closed`, which
   * is terminal and unrecoverable from the app.
   *
   * Guarded on `open` so a double-tap, or a pause racing a close, updates nothing.
   */
  async pauseOwnedIfOpen(jobId: string, tenant: TenantKey, now: Date): Promise<Job | undefined> {
    const [row] = await this.db
      .update(jobs)
      .set({ status: "paused", updatedAt: now })
      .where(and(eq(jobs.id, jobId), eq(jobs.payerId, tenant), eq(jobs.status, "open")))
      .returning();
    return row;
  }

  /**
   * RESUME an OWNED job: `paused -> open` (#1202).
   *
   * Guarded on `paused` specifically, NOT on "not closed". That matters for one case: a
   * `suspended` job must never be resumable by its payer, because `suspended` is
   * SYSTEM-owned (ADR-0037) and only reinstatement may lift it. A suspended payer cannot
   * reach this route anyway (PayerAuthGuard admits `active` only), but the guard belongs in
   * the WHERE rather than resting on that.
   */
  async resumeOwnedIfPaused(
    jobId: string,
    tenant: TenantKey,
    now: Date,
  ): Promise<Job | undefined> {
    const [row] = await this.db
      .update(jobs)
      .set({ status: "open", updatedAt: now })
      .where(and(eq(jobs.id, jobId), eq(jobs.payerId, tenant), eq(jobs.status, "paused")))
      .returning();
    return row;
  }

  // ───────────────────── Ops (ADR-0050 §6.1 step 2, #1983) ─────────────────────

  /**
   * Fetch an AGENCY job by id for the ops match-skill route — NOT owner-scoped (ops acts on
   * any agency's job), but scoped to AGENCY rows: the owning payer must exist with
   * `role = 'agent'`. A seed/ops row (`payer_id` NULL) or an employer-owned legacy row returns
   * undefined, so the route can never write match input onto a row ADR-0050 does not twin.
   * One PK probe joined to one PK probe.
   */
  async findAgencyJobById(jobId: string): Promise<Job | undefined> {
    const [row] = await this.db
      .select({ job: jobs })
      .from(jobs)
      .innerJoin(payers, eq(payers.id, jobs.payerId))
      .where(and(eq(jobs.id, jobId), eq(payers.role, "agent")))
      .limit(1);
    return row?.job;
  }

  /**
   * Set `match_skill_ids` on a NON-CLOSED job (ops). `closed` is terminal for edits exactly as
   * on the agency's own PATCH, and the guard sits in the WHERE so an edit racing a close
   * updates nothing and returns undefined.
   */
  async setMatchSkillIdsIfNotClosed(
    jobId: string,
    matchSkillIds: string[],
    now: Date,
  ): Promise<Job | undefined> {
    const [row] = await this.db
      .update(jobs)
      .set({ matchSkillIds, updatedAt: now })
      .where(and(eq(jobs.id, jobId), ne(jobs.status, "closed")))
      .returning();
    return row;
  }
}
