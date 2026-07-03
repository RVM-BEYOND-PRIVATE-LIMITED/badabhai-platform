import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { type Database, jobPostings, type JobPosting, type NewJobPosting } from "@badabhai/db";
import type { JobPostingStatus } from "@badabhai/types";
import { DATABASE } from "../database/database.module";

/** Fields a PATCH may set on a job_postings row (column-shaped, snake-internal). */
export type JobPostingUpdate = Partial<
  Pick<
    NewJobPosting,
    "orgLabel" | "roleTitle" | "locationLabel" | "description" | "vacancyBand" | "status"
  >
> & { updatedAt: Date };

@Injectable()
export class JobPostingsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(input: NewJobPosting): Promise<JobPosting> {
    const inserted = await this.db.insert(jobPostings).values(input).returning();
    const row = inserted[0];
    if (!row) throw new Error("Failed to create job posting");
    return row;
  }

  async findById(id: string): Promise<JobPosting | undefined> {
    const rows = await this.db.select().from(jobPostings).where(eq(jobPostings.id, id)).limit(1);
    return rows[0];
  }

  /** List postings newest first, optionally filtered by status. */
  async list(status?: JobPostingStatus, limit = 100): Promise<JobPosting[]> {
    const where = status ? eq(jobPostings.status, status) : undefined;
    return this.db
      .select()
      .from(jobPostings)
      .where(where)
      .orderBy(desc(jobPostings.createdAt))
      .limit(limit);
  }

  /**
   * Apply a field/status update; returns the updated row, or undefined if gone.
   *
   * Intentionally guarded on `id` only (last-writer-wins): for a single-operator
   * internal register, concurrent edits are acceptable. Only the terminal
   * `closed` transition is status-guarded (see `close`) — that is the one
   * invariant we must not lose to a race. The service's pre-read `closed` check
   * is best-effort, not a lock.
   */
  async update(id: string, patch: JobPostingUpdate): Promise<JobPosting | undefined> {
    const rows = await this.db
      .update(jobPostings)
      .set(patch)
      .where(eq(jobPostings.id, id))
      .returning();
    return rows[0];
  }

  /**
   * Transition a posting to `closed`, setting closed_at/updated_at. Guarded on the
   * current status so an already-closed row (a redelivered/concurrent close) is a
   * no-op at the DB and returns undefined — the service maps that to a 409.
   */
  async close(
    id: string,
    previousStatus: "draft" | "open",
    closedAt: Date,
  ): Promise<JobPosting | undefined> {
    const rows = await this.db
      .update(jobPostings)
      .set({ status: "closed", closedAt, updatedAt: closedAt })
      .where(and(eq(jobPostings.id, id), eq(jobPostings.status, previousStatus)))
      .returning();
    return rows[0];
  }

  // ---------------------------------------------------------------------------
  // PAYER self-serve scope (ADR-0019 / ADR-0022 module 9 → ADR-0027 B5.x Inc 1).
  // OWNERSHIP is now the caller's ORG, not the creating payer: every read/write is
  // guarded on `org_id` IN THE QUERY, so ANY member of the org (owner + recruiter)
  // shares the org's postings, and tenancy is enforced at the data layer (XB-A
  // horizontal authz), not just the service. `org_id` is the SESSION-resolved org the
  // controller passes (from @CurrentOrg — never a body/route value). For today's solo
  // orgs (org == the one payer) this is behavior-preserving. `payer_id` is STILL
  // stamped on create (rollback + the org_id_when_payer CHECK), but it is no longer an
  // ownership predicate.
  // ---------------------------------------------------------------------------

  /**
   * Org-scoped read (NO-ORACLE, F-3): the row ONLY if it exists AND belongs to `orgId`.
   * A not-found id and another org's id BOTH resolve to `undefined`, so the service maps
   * both to the SAME neutral 404 (a member cannot probe another org's ids).
   */
  async findByIdAndOrg(id: string, orgId: string): Promise<JobPosting | undefined> {
    const rows = await this.db
      .select()
      .from(jobPostings)
      .where(and(eq(jobPostings.id, id), eq(jobPostings.orgId, orgId)))
      .limit(1);
    return rows[0];
  }

  /** An org's OWN postings newest first, optionally filtered by status (any member sees all). */
  async listByOrg(orgId: string, status?: JobPostingStatus, limit = 100): Promise<JobPosting[]> {
    const where = status
      ? and(eq(jobPostings.orgId, orgId), eq(jobPostings.status, status))
      : eq(jobPostings.orgId, orgId);
    return this.db
      .select()
      .from(jobPostings)
      .where(where)
      .orderBy(desc(jobPostings.createdAt))
      .limit(limit);
  }

  /**
   * Org-scoped field/status update: guarded on `id` AND `org_id`, so a caller can only
   * mutate a row in its OWN org (the ownership lives in the WHERE — no TOCTOU window
   * between an ownership read and the write). Returns undefined if gone or not-in-org.
   */
  async updateOwned(
    id: string,
    orgId: string,
    patch: JobPostingUpdate,
  ): Promise<JobPosting | undefined> {
    const rows = await this.db
      .update(jobPostings)
      .set(patch)
      .where(and(eq(jobPostings.id, id), eq(jobPostings.orgId, orgId)))
      .returning();
    return rows[0];
  }

  /**
   * Org-scoped close: guarded on `id` AND `org_id` AND the current status, so an
   * already-closed, gone, or not-in-org row is a DB no-op → undefined (service maps to
   * 409/404 — without leaking which).
   */
  async closeOwned(
    id: string,
    orgId: string,
    previousStatus: "draft" | "open",
    closedAt: Date,
  ): Promise<JobPosting | undefined> {
    const rows = await this.db
      .update(jobPostings)
      .set({ status: "closed", closedAt, updatedAt: closedAt })
      .where(
        and(
          eq(jobPostings.id, id),
          eq(jobPostings.orgId, orgId),
          eq(jobPostings.status, previousStatus),
        ),
      )
      .returning();
    return rows[0];
  }

  /**
   * Org-scoped status transition (B1; ADR-0027 B5.x Inc 3): guarded on `id` AND `org_id` AND
   * the current status, so a wrong-state / gone / not-in-org row is a DB no-op → undefined
   * (the service maps that to a 409/404, without leaking which — the ownership lives in the
   * WHERE, no TOCTOU). Mirrors {@link updateOwned}/{@link closeOwned} for the reversible
   * open<->paused transitions (pause: open→paused, resume: paused→open).
   */
  async transitionOwned(
    id: string,
    orgId: string,
    fromStatus: JobPostingStatus,
    toStatus: JobPostingStatus,
  ): Promise<JobPosting | undefined> {
    const rows = await this.db
      .update(jobPostings)
      .set({ status: toStatus, updatedAt: new Date() })
      .where(
        and(
          eq(jobPostings.id, id),
          eq(jobPostings.orgId, orgId),
          eq(jobPostings.status, fromStatus),
        ),
      )
      .returning();
    return rows[0];
  }
}
