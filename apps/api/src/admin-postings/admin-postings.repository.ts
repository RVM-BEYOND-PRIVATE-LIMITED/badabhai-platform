import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
  auditLogs,
  jobPostings,
  jobs,
  type Database,
  type Job,
  type JobPosting,
  type JobStatus,
  type NewJob,
  type NewJobPosting,
} from "@badabhai/db";
import type { JobPostingVerificationStatus } from "@badabhai/types";
import { DATABASE } from "../database/database.module";

/** A posting/job patch prepared by the owning domain service. */
export type PostingPatch = Partial<NewJobPosting> & { updatedAt: Date };
export type JobPatch = Partial<NewJob> & { updatedAt: Date };

/** The full hidden state an admin write stamps, or `null` to clear it. */
export interface HiddenState {
  hiddenAt: Date;
  hiddenBy: string;
  hiddenReasonCode: string;
  hiddenReasonText: string;
}

/**
 * The admin posting-control write repository (#2566).
 *
 * It owns the SoR writes for BOTH served-inventory tables, always on a CALLER transaction
 * (`tx` is required, never defaulted) so the row change, its `audit_logs` reason, its
 * `admin.action_performed` and its domain event commit together or not at all. Reads are
 * one PK probe each.
 */
@Injectable()
export class AdminPostingsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  async findPosting(id: string): Promise<JobPosting | undefined> {
    const [row] = await this.db.select().from(jobPostings).where(eq(jobPostings.id, id)).limit(1);
    return row;
  }

  async findJob(id: string): Promise<Job | undefined> {
    const [row] = await this.db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
    return row;
  }

  async updatePosting(id: string, patch: PostingPatch, tx: Database): Promise<JobPosting> {
    const [row] = await tx.update(jobPostings).set(patch).where(eq(jobPostings.id, id)).returning();
    if (!row) throw new Error(`job_posting ${id} disappeared inside its write transaction`);
    return row;
  }

  async updateJob(id: string, patch: JobPatch, tx: Database): Promise<Job> {
    const [row] = await tx.update(jobs).set(patch).where(eq(jobs.id, id)).returning();
    if (!row) throw new Error(`job ${id} disappeared inside its write transaction`);
    return row;
  }

  /** Guarded status move (open→paused, paused→open). undefined when the guard did not match. */
  async movePostingStatus(
    id: string,
    from: JobPosting["status"],
    to: JobPosting["status"],
    tx: Database,
  ): Promise<JobPosting | undefined> {
    const [row] = await tx
      .update(jobPostings)
      .set({ status: to, updatedAt: new Date() })
      .where(and(eq(jobPostings.id, id), eq(jobPostings.status, from)))
      .returning();
    return row;
  }

  async moveJobStatus(
    id: string,
    from: JobStatus,
    to: JobStatus,
    tx: Database,
  ): Promise<Job | undefined> {
    const [row] = await tx
      .update(jobs)
      .set({ status: to, updatedAt: new Date() })
      .where(and(eq(jobs.id, id), eq(jobs.status, from)))
      .returning();
    return row;
  }

  /**
   * Close a posting from ANY non-closed state. `previous_status` is cleared in the same
   * statement because `job_postings_previous_status_chk` rejects a non-suspended row that
   * still carries one (the ADR-0037 rule the force-close path documents).
   */
  async closePosting(
    id: string,
    from: JobPosting["status"],
    closedAt: Date,
    tx: Database,
  ): Promise<JobPosting | undefined> {
    const [row] = await tx
      .update(jobPostings)
      .set({ status: "closed", previousStatus: null, closedAt, updatedAt: closedAt })
      .where(and(eq(jobPostings.id, id), eq(jobPostings.status, from)))
      .returning();
    return row;
  }

  async closeJob(id: string, from: JobStatus, tx: Database): Promise<Job | undefined> {
    const [row] = await tx
      .update(jobs)
      .set({ status: "closed", updatedAt: new Date() })
      .where(and(eq(jobs.id, id), eq(jobs.status, from)))
      .returning();
    return row;
  }

  async hidePosting(id: string, state: HiddenState, tx: Database): Promise<JobPosting | undefined> {
    const [row] = await tx
      .update(jobPostings)
      .set({
        hiddenAt: state.hiddenAt,
        hiddenBy: state.hiddenBy,
        hiddenReasonCode: state.hiddenReasonCode,
        hiddenReasonText: state.hiddenReasonText,
        updatedAt: new Date(),
      })
      .where(and(eq(jobPostings.id, id), isNull(jobPostings.hiddenAt)))
      .returning();
    return row;
  }

  async unhidePosting(id: string, tx: Database): Promise<JobPosting | undefined> {
    const [row] = await tx
      .update(jobPostings)
      .set({
        hiddenAt: null,
        hiddenBy: null,
        hiddenReasonCode: null,
        hiddenReasonText: null,
        updatedAt: new Date(),
      })
      .where(and(eq(jobPostings.id, id), isNotNull(jobPostings.hiddenAt)))
      .returning();
    return row;
  }

  async hideJob(id: string, state: HiddenState, tx: Database): Promise<Job | undefined> {
    const [row] = await tx
      .update(jobs)
      .set({
        hiddenAt: state.hiddenAt,
        hiddenBy: state.hiddenBy,
        hiddenReasonCode: state.hiddenReasonCode,
        hiddenReasonText: state.hiddenReasonText,
        updatedAt: new Date(),
      })
      .where(and(eq(jobs.id, id), isNull(jobs.hiddenAt)))
      .returning();
    return row;
  }

  async unhideJob(id: string, tx: Database): Promise<Job | undefined> {
    const [row] = await tx
      .update(jobs)
      .set({
        hiddenAt: null,
        hiddenBy: null,
        hiddenReasonCode: null,
        hiddenReasonText: null,
        updatedAt: new Date(),
      })
      .where(and(eq(jobs.id, id), isNotNull(jobs.hiddenAt)))
      .returning();
    return row;
  }

  async setPostingVerification(
    id: string,
    from: JobPostingVerificationStatus,
    next: JobPostingVerificationStatus,
    tx: Database,
  ): Promise<JobPosting | undefined> {
    const [row] = await tx
      .update(jobPostings)
      .set({ verificationStatus: next, updatedAt: new Date() })
      .where(and(eq(jobPostings.id, id), eq(jobPostings.verificationStatus, from)))
      .returning();
    return row;
  }

  async setJobVerification(
    id: string,
    from: JobPostingVerificationStatus,
    next: JobPostingVerificationStatus,
    tx: Database,
  ): Promise<Job | undefined> {
    const [row] = await tx
      .update(jobs)
      .set({ verificationStatus: next, updatedAt: new Date() })
      .where(and(eq(jobs.id, id), eq(jobs.verificationStatus, from)))
      .returning();
    return row;
  }

  /**
   * The written reason + the closed code, on `audit_logs`. Kept separate from
   * `AdminActionsRepository.writeAuditReason` because that one hardcodes `entity_type =
   * 'worker'`; this surface writes postings/jobs and must never be reachable from the worker
   * account actions.
   */
  async writeAudit(
    tx: Database,
    input: {
      adminId: string;
      action: string;
      entityType: "job_posting" | "job";
      entityId: string;
      reasonCode: string;
      reasonText: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    await tx.insert(auditLogs).values({
      actorType: "admin",
      actorId: input.adminId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      metadata: {
        reason_code: input.reasonCode,
        reason_text: input.reasonText,
        ...(input.metadata ?? {}),
      },
    });
  }
}
