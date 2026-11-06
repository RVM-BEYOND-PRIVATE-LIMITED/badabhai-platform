import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { Database, Job, JobPosting } from "@badabhai/db";
import type { JobPostingVerificationStatus } from "@badabhai/types";
import type { RequestContext } from "../common/request-context";
import { ADMIN_ACTION_CODES, type AdminActionCode } from "../admin/admin-action-codes";
import { EventsService } from "../events/events.service";
import { JobPostingsService } from "../job-postings/job-postings.service";
import { UpdateJobPostingSchema, type UpdateJobPostingDto } from "../job-postings/job-postings.dto";
import { toJobPostingApi } from "../job-postings/job-postings.repository";
import { AgencyService } from "../agency/agency.service";
import { UpdateAgencyJobSchema, type UpdateAgencyJobDto } from "../agency/agency.dto";
import { AgencyTwinService } from "../agency-twin/agency-twin.service";
import {
  AdminPostingsRepository,
  type HiddenState,
  type JobPatch,
} from "./admin-postings.repository";
import type {
  AdminPostingActionResult,
  AdminPostingEditDto,
  AdminPostingReasonDto,
  AdminPostingVerificationReasonDto,
} from "./admin-postings.dto";

/** The row an admin action actually addresses. A twin resolves to its SOURCE agency job. */
type Target = { kind: "posting"; posting: JobPosting } | { kind: "job"; job: Job };

type EntityType = "job_posting" | "job";

/**
 * #2566 — ADMIN posting control.
 *
 * Every method follows one shape:
 *   1. resolve `:id` to the row that is allowed to change (a twin → its source job, because
 *      ADR-0050 makes the sync the only writer of a twin);
 *   2. validate the transition/idempotence BEFORE opening a transaction;
 *   3. in ONE transaction write the SoR row, its `audit_logs` reason, EXACTLY ONE
 *      `admin.action_performed`, and the domain event — plus, for an agency job, converge its
 *      twin through the ADR-0050 sync on the SAME transaction.
 *
 * The actor is ALWAYS the session admin (`adminId`), never a body value. The reason text and
 * every before/after value live on the SoR row + `audit_logs`; no payload carries them.
 */
@Injectable()
export class AdminPostingsService {
  constructor(
    private readonly repo: AdminPostingsRepository,
    private readonly events: EventsService,
    private readonly jobPostings: JobPostingsService,
    private readonly agency: AgencyService,
    private readonly agencyTwin: AgencyTwinService,
  ) {}

  // ----- edit ---------------------------------------------------------------

  async edit(
    adminId: string,
    id: string,
    dto: AdminPostingEditDto,
    ctx: RequestContext,
  ): Promise<AdminPostingActionResult> {
    if (dto.changes.status !== undefined) {
      throw new BadRequestException(
        "status is changed by the pause, resume and close actions, never by edit",
      );
    }
    const target = await this.resolve(id);

    if (target.kind === "posting") {
      if (target.posting.status === "closed") {
        throw new ConflictException("A closed posting cannot be edited");
      }
      const parsed = AdminPostingsService.parsePostingEdit(dto.changes);
      const prepared = await this.jobPostings.prepareAdminEdit(target.posting.id, parsed, ctx);
      const updated = await this.repo.withTransaction(async (tx) => {
        const row = await this.repo.updatePosting(target.posting.id, prepared.patch, tx);
        await this.repo.writeAudit(tx, {
          adminId,
          action: ADMIN_ACTION_CODES.posting_edited,
          entityType: "job_posting",
          entityId: row.id,
          reasonCode: dto.reason_code,
          reasonText: dto.reason_text,
          metadata: { changed_fields: prepared.changedFields },
        });
        await this.emitPostingUpdated(
          tx,
          row,
          prepared.changedFields,
          prepared.bandChanged,
          adminId,
          ctx,
        );
        await this.emitAction(
          tx,
          adminId,
          ADMIN_ACTION_CODES.posting_edited,
          "job_posting",
          row.id,
          ctx,
        );
        return row;
      });
      // The reach set is a REBUILDABLE CACHE, never part of the atomic write. The SoR row,
      // reason, audit and event have committed; a materialization failure is logged and
      // repaired by `db:materialize:reach` (the same contract a payer edit has).
      await this.jobPostings.materializeAfterAdminEdit(
        { before: prepared.before, tradeDto: prepared.tradeDto },
        toJobPostingApi(updated),
        adminId,
        ctx,
      );
      return { target_id: updated.id, entity_type: "job_posting", changed: true };
    }

    const job = target.job;
    if (job.status === "closed") {
      throw new ConflictException("A closed job cannot be edited");
    }
    const parsed = AdminPostingsService.parseJobEdit(dto.changes);
    const prepared = await this.agency.prepareAdminEdit(job, parsed);
    const updated = await this.repo.withTransaction(async (tx) => {
      const row = await this.repo.updateJob(job.id, prepared.patch as JobPatch, tx);
      await this.syncTwin(tx, job.id);
      await this.repo.writeAudit(tx, {
        adminId,
        action: ADMIN_ACTION_CODES.posting_edited,
        entityType: "job",
        entityId: row.id,
        reasonCode: dto.reason_code,
        reasonText: dto.reason_text,
        metadata: { changed_fields: prepared.changedFields },
      });
      await this.emitJobUpdated(tx, row, prepared.changedFields, adminId, ctx);
      await this.emitAction(tx, adminId, ADMIN_ACTION_CODES.posting_edited, "job", row.id, ctx);
      return row;
    });
    return { target_id: updated.id, entity_type: "job", changed: true };
  }

  // ----- pause / resume -----------------------------------------------------

  async pause(
    adminId: string,
    id: string,
    dto: AdminPostingReasonDto,
    ctx: RequestContext,
  ): Promise<AdminPostingActionResult> {
    const target = await this.resolve(id);
    if (AdminPostingsService.statusOf(target) === "paused") {
      return AdminPostingsService.noop(target);
    }
    if (AdminPostingsService.statusOf(target) !== "open") {
      throw new ConflictException("Only an open posting can be paused");
    }

    if (target.kind === "posting") {
      const row = await this.repo.withTransaction(async (tx) => {
        const moved = await this.repo.movePostingStatus(target.posting.id, "open", "paused", tx);
        if (!moved) return undefined;
        await this.repo.writeAudit(tx, {
          adminId,
          action: ADMIN_ACTION_CODES.posting_paused,
          entityType: "job_posting",
          entityId: moved.id,
          reasonCode: dto.reason_code,
          reasonText: dto.reason_text,
          metadata: { previous_status: "open", status: "paused" },
        });
        const payload: PayloadInputOf<"job_posting.paused"> = {
          job_posting_id: moved.id,
          previous_status: "open",
          status: "paused",
        };
        await this.emitDomain(
          tx,
          "job_posting.paused",
          "job_posting",
          moved.id,
          payload,
          adminId,
          ctx,
        );
        await this.emitAction(
          tx,
          adminId,
          ADMIN_ACTION_CODES.posting_paused,
          "job_posting",
          moved.id,
          ctx,
        );
        return moved;
      });
      if (!row) throw new ConflictException("Posting status changed concurrently; retry");
      return { target_id: row.id, entity_type: "job_posting", changed: true };
    }

    const row = await this.repo.withTransaction(async (tx) => {
      const moved = await this.repo.moveJobStatus(target.job.id, "open", "paused", tx);
      if (!moved) return undefined;
      await this.syncTwin(tx, moved.id);
      await this.repo.writeAudit(tx, {
        adminId,
        action: ADMIN_ACTION_CODES.posting_paused,
        entityType: "job",
        entityId: moved.id,
        reasonCode: dto.reason_code,
        reasonText: dto.reason_text,
        metadata: { previous_status: "open", status: "paused" },
      });
      await this.emitJobUpdated(tx, moved, ["status"], adminId, ctx);
      await this.emitAction(tx, adminId, ADMIN_ACTION_CODES.posting_paused, "job", moved.id, ctx);
      return moved;
    });
    if (!row) throw new ConflictException("Job status changed concurrently; retry");
    return { target_id: row.id, entity_type: "job", changed: true };
  }

  async resume(
    adminId: string,
    id: string,
    dto: AdminPostingReasonDto,
    ctx: RequestContext,
  ): Promise<AdminPostingActionResult> {
    const target = await this.resolve(id);
    if (AdminPostingsService.statusOf(target) === "open") {
      return AdminPostingsService.noop(target);
    }
    if (AdminPostingsService.statusOf(target) !== "paused") {
      throw new ConflictException("Only a paused posting can be resumed");
    }

    if (target.kind === "posting") {
      const row = await this.repo.withTransaction(async (tx) => {
        const moved = await this.repo.movePostingStatus(target.posting.id, "paused", "open", tx);
        if (!moved) return undefined;
        await this.repo.writeAudit(tx, {
          adminId,
          action: ADMIN_ACTION_CODES.posting_resumed,
          entityType: "job_posting",
          entityId: moved.id,
          reasonCode: dto.reason_code,
          reasonText: dto.reason_text,
          metadata: { previous_status: "paused", status: "open" },
        });
        const payload: PayloadInputOf<"job_posting.resumed"> = {
          job_posting_id: moved.id,
          previous_status: "paused",
          status: "open",
        };
        await this.emitDomain(
          tx,
          "job_posting.resumed",
          "job_posting",
          moved.id,
          payload,
          adminId,
          ctx,
        );
        await this.emitAction(
          tx,
          adminId,
          ADMIN_ACTION_CODES.posting_resumed,
          "job_posting",
          moved.id,
          ctx,
        );
        return moved;
      });
      if (!row) throw new ConflictException("Posting status changed concurrently; retry");
      return { target_id: row.id, entity_type: "job_posting", changed: true };
    }

    const row = await this.repo.withTransaction(async (tx) => {
      const moved = await this.repo.moveJobStatus(target.job.id, "paused", "open", tx);
      if (!moved) return undefined;
      await this.syncTwin(tx, moved.id);
      await this.repo.writeAudit(tx, {
        adminId,
        action: ADMIN_ACTION_CODES.posting_resumed,
        entityType: "job",
        entityId: moved.id,
        reasonCode: dto.reason_code,
        reasonText: dto.reason_text,
        metadata: { previous_status: "paused", status: "open" },
      });
      await this.emitJobUpdated(tx, moved, ["status"], adminId, ctx);
      await this.emitAction(tx, adminId, ADMIN_ACTION_CODES.posting_resumed, "job", moved.id, ctx);
      return moved;
    });
    if (!row) throw new ConflictException("Job status changed concurrently; retry");
    return { target_id: row.id, entity_type: "job", changed: true };
  }

  // ----- close (final — no reopen) -----------------------------------------

  async close(
    adminId: string,
    id: string,
    dto: AdminPostingReasonDto,
    ctx: RequestContext,
  ): Promise<AdminPostingActionResult> {
    const target = await this.resolve(id);
    if (AdminPostingsService.statusOf(target) === "closed") {
      return AdminPostingsService.noop(target);
    }

    if (target.kind === "posting") {
      const previous = target.posting.status;
      const row = await this.repo.withTransaction(async (tx) => {
        const closed = await this.repo.closePosting(target.posting.id, previous, new Date(), tx);
        if (!closed) return undefined;
        await this.repo.writeAudit(tx, {
          adminId,
          action: ADMIN_ACTION_CODES.posting_closed,
          entityType: "job_posting",
          entityId: closed.id,
          reasonCode: dto.reason_code,
          reasonText: dto.reason_text,
          metadata: { previous_status: previous, status: "closed" },
        });
        const payload: PayloadInputOf<"job_posting.admin_closed"> = {
          job_posting_id: closed.id,
          previous_status: previous,
          status: "closed",
        };
        await this.emitDomain(
          tx,
          "job_posting.admin_closed",
          "job_posting",
          closed.id,
          payload,
          adminId,
          ctx,
        );
        await this.emitAction(
          tx,
          adminId,
          ADMIN_ACTION_CODES.posting_closed,
          "job_posting",
          closed.id,
          ctx,
        );
        return closed;
      });
      if (!row) throw new ConflictException("Posting status changed concurrently; retry");
      return { target_id: row.id, entity_type: "job_posting", changed: true };
    }

    const previous = target.job.status;
    const row = await this.repo.withTransaction(async (tx) => {
      const closed = await this.repo.closeJob(target.job.id, previous, tx);
      if (!closed) return undefined;
      await this.syncTwin(tx, closed.id);
      await this.repo.writeAudit(tx, {
        adminId,
        action: ADMIN_ACTION_CODES.posting_closed,
        entityType: "job",
        entityId: closed.id,
        reasonCode: dto.reason_code,
        reasonText: dto.reason_text,
        metadata: { previous_status: previous, status: "closed" },
      });
      if (closed.payerId) {
        const payload: PayloadInputOf<"job.closed"> = {
          job_id: closed.id,
          payer_id: closed.payerId,
          previous_status: previous,
          status: "closed",
        };
        await this.emitDomain(tx, "job.closed", "job", closed.id, payload, adminId, ctx);
      }
      await this.emitAction(tx, adminId, ADMIN_ACTION_CODES.posting_closed, "job", closed.id, ctx);
      return closed;
    });
    if (!row) throw new ConflictException("Job status changed concurrently; retry");
    return { target_id: row.id, entity_type: "job", changed: true };
  }

  // ----- hide / unhide (separate from status) -------------------------------

  async hide(
    adminId: string,
    id: string,
    dto: AdminPostingReasonDto,
    ctx: RequestContext,
  ): Promise<AdminPostingActionResult> {
    const target = await this.resolve(id);
    if (AdminPostingsService.isHidden(target)) return AdminPostingsService.noop(target);
    const state: HiddenState = {
      hiddenAt: new Date(),
      hiddenBy: adminId,
      hiddenReasonCode: dto.reason_code,
      hiddenReasonText: dto.reason_text,
    };

    if (target.kind === "posting") {
      const row = await this.repo.withTransaction(async (tx) => {
        const hidden = await this.repo.hidePosting(target.posting.id, state, tx);
        if (!hidden) return undefined;
        await this.repo.writeAudit(tx, {
          adminId,
          action: ADMIN_ACTION_CODES.posting_hidden,
          entityType: "job_posting",
          entityId: hidden.id,
          reasonCode: dto.reason_code,
          reasonText: dto.reason_text,
          metadata: { status: hidden.status },
        });
        const payload: PayloadInputOf<"job_posting.hidden"> = { job_posting_id: hidden.id };
        await this.emitDomain(
          tx,
          "job_posting.hidden",
          "job_posting",
          hidden.id,
          payload,
          adminId,
          ctx,
        );
        await this.emitAction(
          tx,
          adminId,
          ADMIN_ACTION_CODES.posting_hidden,
          "job_posting",
          hidden.id,
          ctx,
        );
        return hidden;
      });
      if (!row) return { target_id: id, entity_type: "job_posting", changed: false };
      return { target_id: row.id, entity_type: "job_posting", changed: true };
    }

    const row = await this.repo.withTransaction(async (tx) => {
      const hidden = await this.repo.hideJob(target.job.id, state, tx);
      if (!hidden) return undefined;
      await this.syncTwin(tx, hidden.id);
      await this.repo.writeAudit(tx, {
        adminId,
        action: ADMIN_ACTION_CODES.posting_hidden,
        entityType: "job",
        entityId: hidden.id,
        reasonCode: dto.reason_code,
        reasonText: dto.reason_text,
        metadata: { status: hidden.status },
      });
      const payload: PayloadInputOf<"job.hidden"> = { job_id: hidden.id };
      await this.emitDomain(tx, "job.hidden", "job", hidden.id, payload, adminId, ctx);
      await this.emitAction(tx, adminId, ADMIN_ACTION_CODES.posting_hidden, "job", hidden.id, ctx);
      return hidden;
    });
    if (!row) return { target_id: id, entity_type: "job", changed: false };
    return { target_id: row.id, entity_type: "job", changed: true };
  }

  async unhide(
    adminId: string,
    id: string,
    dto: AdminPostingReasonDto,
    ctx: RequestContext,
  ): Promise<AdminPostingActionResult> {
    const target = await this.resolve(id);
    if (!AdminPostingsService.isHidden(target)) return AdminPostingsService.noop(target);

    if (target.kind === "posting") {
      const row = await this.repo.withTransaction(async (tx) => {
        const shown = await this.repo.unhidePosting(target.posting.id, tx);
        if (!shown) return undefined;
        await this.repo.writeAudit(tx, {
          adminId,
          action: ADMIN_ACTION_CODES.posting_unhidden,
          entityType: "job_posting",
          entityId: shown.id,
          reasonCode: dto.reason_code,
          reasonText: dto.reason_text,
          metadata: { status: shown.status },
        });
        const payload: PayloadInputOf<"job_posting.unhidden"> = { job_posting_id: shown.id };
        await this.emitDomain(
          tx,
          "job_posting.unhidden",
          "job_posting",
          shown.id,
          payload,
          adminId,
          ctx,
        );
        await this.emitAction(
          tx,
          adminId,
          ADMIN_ACTION_CODES.posting_unhidden,
          "job_posting",
          shown.id,
          ctx,
        );
        return shown;
      });
      if (!row) return { target_id: id, entity_type: "job_posting", changed: false };
      return { target_id: row.id, entity_type: "job_posting", changed: true };
    }

    const row = await this.repo.withTransaction(async (tx) => {
      const shown = await this.repo.unhideJob(target.job.id, tx);
      if (!shown) return undefined;
      await this.syncTwin(tx, shown.id);
      await this.repo.writeAudit(tx, {
        adminId,
        action: ADMIN_ACTION_CODES.posting_unhidden,
        entityType: "job",
        entityId: shown.id,
        reasonCode: dto.reason_code,
        reasonText: dto.reason_text,
        metadata: { status: shown.status },
      });
      const payload: PayloadInputOf<"job.unhidden"> = { job_id: shown.id };
      await this.emitDomain(tx, "job.unhidden", "job", shown.id, payload, adminId, ctx);
      await this.emitAction(tx, adminId, ADMIN_ACTION_CODES.posting_unhidden, "job", shown.id, ctx);
      return shown;
    });
    if (!row) return { target_id: id, entity_type: "job", changed: false };
    return { target_id: row.id, entity_type: "job", changed: true };
  }

  // ----- verify / reject ----------------------------------------------------

  verify(
    adminId: string,
    id: string,
    dto: AdminPostingVerificationReasonDto,
    ctx: RequestContext,
  ): Promise<AdminPostingActionResult> {
    return this.setVerification(adminId, id, "verified", dto, ctx);
  }

  reject(
    adminId: string,
    id: string,
    dto: AdminPostingVerificationReasonDto,
    ctx: RequestContext,
  ): Promise<AdminPostingActionResult> {
    return this.setVerification(adminId, id, "rejected", dto, ctx);
  }

  private async setVerification(
    adminId: string,
    id: string,
    next: JobPostingVerificationStatus,
    dto: AdminPostingVerificationReasonDto,
    ctx: RequestContext,
  ): Promise<AdminPostingActionResult> {
    const target = await this.resolve(id);
    if (AdminPostingsService.verificationOf(target) === next) {
      return AdminPostingsService.noop(target);
    }

    if (target.kind === "posting") {
      const previous = target.posting.verificationStatus;
      const row = await this.repo.withTransaction(async (tx) => {
        const moved = await this.repo.setPostingVerification(target.posting.id, previous, next, tx);
        if (!moved) return undefined;
        await this.repo.writeAudit(tx, {
          adminId,
          action:
            next === "verified"
              ? ADMIN_ACTION_CODES.posting_verified
              : ADMIN_ACTION_CODES.posting_rejected,
          entityType: "job_posting",
          entityId: moved.id,
          reasonCode: dto.reason_code,
          reasonText: dto.reason_text,
          metadata: { previous_status: previous, verification_status: next },
        });
        const payload: PayloadInputOf<"job_posting.verification_updated"> = {
          job_posting_id: moved.id,
          verification_status: next,
          previous_status: previous,
        };
        await this.emitDomain(
          tx,
          "job_posting.verification_updated",
          "job_posting",
          moved.id,
          payload,
          adminId,
          ctx,
        );
        await this.emitAction(
          tx,
          adminId,
          next === "verified"
            ? ADMIN_ACTION_CODES.posting_verified
            : ADMIN_ACTION_CODES.posting_rejected,
          "job_posting",
          moved.id,
          ctx,
        );
        return moved;
      });
      if (!row) throw new ConflictException("Verification changed concurrently; retry");
      return { target_id: row.id, entity_type: "job_posting", changed: true };
    }

    const previous = target.job.verificationStatus;
    const row = await this.repo.withTransaction(async (tx) => {
      const moved = await this.repo.setJobVerification(target.job.id, previous, next, tx);
      if (!moved) return undefined;
      await this.syncTwin(tx, moved.id);
      await this.repo.writeAudit(tx, {
        adminId,
        action:
          next === "verified"
            ? ADMIN_ACTION_CODES.posting_verified
            : ADMIN_ACTION_CODES.posting_rejected,
        entityType: "job",
        entityId: moved.id,
        reasonCode: dto.reason_code,
        reasonText: dto.reason_text,
        metadata: { previous_status: previous, verification_status: next },
      });
      const payload: PayloadInputOf<"job.verification_updated"> = {
        job_id: moved.id,
        verification_status: next,
        previous_status: previous,
      };
      await this.emitDomain(tx, "job.verification_updated", "job", moved.id, payload, adminId, ctx);
      await this.emitAction(
        tx,
        adminId,
        next === "verified"
          ? ADMIN_ACTION_CODES.posting_verified
          : ADMIN_ACTION_CODES.posting_rejected,
        "job",
        moved.id,
        ctx,
      );
      return moved;
    });
    if (!row) throw new ConflictException("Verification changed concurrently; retry");
    return { target_id: row.id, entity_type: "job", changed: true };
  }

  // ----- target resolution --------------------------------------------------

  /**
   * A `job_postings` id is the served entity; a `jobs` id is an agency/legacy job. A TWIN
   * posting resolves to its source job (ADR-0050: the sync is the twin's only writer), so
   * an admin acting on the company-visible card still edits the agency's own row.
   */
  private async resolve(id: string): Promise<Target> {
    const posting = await this.repo.findPosting(id);
    if (posting) {
      if (posting.syncSource === "agency_job") {
        const sourceJobId = posting.sourceJobId;
        if (!sourceJobId) throw new NotFoundException("Posting not found");
        const job = await this.repo.findJob(sourceJobId);
        if (!job) throw new NotFoundException("Posting not found");
        return { kind: "job", job };
      }
      return { kind: "posting", posting };
    }
    const job = await this.repo.findJob(id);
    if (job) return { kind: "job", job };
    throw new NotFoundException("Posting not found");
  }

  private static statusOf(target: Target): JobPosting["status"] {
    return target.kind === "posting" ? target.posting.status : target.job.status;
  }

  private static isHidden(target: Target): boolean {
    return target.kind === "posting"
      ? target.posting.hiddenAt !== null
      : target.job.hiddenAt !== null;
  }

  private static verificationOf(target: Target): JobPostingVerificationStatus {
    return target.kind === "posting"
      ? target.posting.verificationStatus
      : target.job.verificationStatus;
  }

  private static noop(target: Target): AdminPostingActionResult {
    return target.kind === "posting"
      ? { target_id: target.posting.id, entity_type: "job_posting", changed: false }
      : { target_id: target.job.id, entity_type: "job", changed: false };
  }

  private static parsePostingEdit(changes: Record<string, unknown>): UpdateJobPostingDto {
    const parsed = UpdateJobPostingSchema.safeParse(changes);
    if (!parsed.success) {
      throw new BadRequestException(
        `Invalid posting changes: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    return parsed.data;
  }

  private static parseJobEdit(changes: Record<string, unknown>): UpdateAgencyJobDto {
    const parsed = UpdateAgencyJobSchema.safeParse(changes);
    if (!parsed.success) {
      throw new BadRequestException(
        `Invalid job changes: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    return parsed.data;
  }

  // ----- emission -----------------------------------------------------------

  /** Converge an agency job's twin on THIS transaction. No-op for a non-agency job. */
  private async syncTwin(tx: Database, jobId: string): Promise<void> {
    await this.agencyTwin.syncWithin(tx, jobId);
  }

  private async emitPostingUpdated(
    tx: Database,
    row: JobPosting,
    changedFields: PayloadInputOf<"job_posting.updated">["changed_fields"],
    bandChanged: boolean,
    adminId: string,
    ctx: RequestContext,
  ): Promise<void> {
    const payload: PayloadInputOf<"job_posting.updated"> = {
      job_posting_id: row.id,
      changed_fields: changedFields,
      status: row.status,
      vacancy_band: bandChanged ? row.vacancyBand : null,
    };
    await this.emitDomain(tx, "job_posting.updated", "job_posting", row.id, payload, adminId, ctx);
  }

  private async emitJobUpdated(
    tx: Database,
    row: Job,
    changedFields: PayloadInputOf<"job.updated">["changed_fields"],
    adminId: string,
    ctx: RequestContext,
  ): Promise<void> {
    // An ops-created `jobs` row has no payer. `job.updated` requires a payer_id, and the
    // admin.action_performed written beside this is the audit fact; skipping the domain
    // event is honest (there is no payer to notify) and cannot emit an invalid payload.
    if (!row.payerId) return;
    const payload: PayloadInputOf<"job.updated"> = {
      job_id: row.id,
      payer_id: row.payerId,
      status: row.status,
      changed_fields: changedFields,
    };
    await this.emitDomain(tx, "job.updated", "job", row.id, payload, adminId, ctx);
  }

  private emitDomain<N extends Parameters<EventsService["emit"]>[0]["event_name"]>(
    tx: Database,
    eventName: N,
    subjectType: EntityType,
    subjectId: string,
    payload: PayloadInputOf<N>,
    adminId: string,
    ctx: RequestContext,
  ): Promise<unknown> {
    return this.events.emit({
      event_name: eventName,
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: subjectType, subject_id: subjectId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      idempotencyKey: `${eventName}:${subjectId}:${ctx.requestId}`,
      tx,
    });
  }

  private emitAction(
    tx: Database,
    adminId: string,
    actionCode: AdminActionCode,
    targetType: EntityType,
    targetId: string,
    ctx: RequestContext,
  ): Promise<unknown> {
    const payload: PayloadInputOf<"admin.action_performed"> = {
      admin_id: adminId,
      action_code: actionCode,
      target_type: targetType,
      target_id: targetId,
    };
    return this.events.emit({
      event_name: "admin.action_performed",
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: targetType, subject_id: targetId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
      idempotencyKey: `admin_action:${actionCode}:${adminId}:${targetId}:${ctx.requestId}`,
      tx,
    });
  }
}
