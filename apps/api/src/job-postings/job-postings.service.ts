import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { JobPosting } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { EventsService, type EmitParams } from "../events/events.service";
import { JobPostingsRepository, type JobPostingUpdate } from "./job-postings.repository";
import type {
  CreateJobPostingDto,
  ListJobPostingsQueryDto,
  UpdateJobPostingDto,
} from "./job-postings.dto";

/**
 * Ops-created, vacancy-banded, stored-only job postings (ADR-0010). Each write
 * emits a registry-validated `job_posting.*` event whose payload carries ONLY
 * ids, enums, booleans, and changed-field KEYS — never the free-text values
 * (org_label / role_title / location_label / description). The free text lives
 * only on the job_postings row; the events record the FACT, not the value.
 *
 * There is NO ops auth in alpha: `created_by` arrives on the create DTO as an
 * opaque ops-actor uuid and is used for the column, the created payload, AND the
 * `actor.actor_id` on every job_posting.* event (the posting's creator is the
 * only ops identity we have). Resolving it from an authenticated ops session is
 * deferred to Phase 2.
 *
 * Lifecycle (ADR open-item b), enforced here:
 *   draft -> open    (via PATCH status="open")
 *   draft -> closed  (via close endpoint)
 *   open  -> closed  (via close endpoint)
 * `closed` is terminal — no reopen, no edits. Field edits are allowed only while
 * the posting is `draft` or `open`. Everything else is rejected.
 */
@Injectable()
export class JobPostingsService {
  constructor(
    private readonly repo: JobPostingsRepository,
    private readonly events: EventsService,
  ) {}

  async create(dto: CreateJobPostingDto, ctx: RequestContext): Promise<JobPosting> {
    // status is ALWAYS draft on create — any client-supplied status is ignored
    // (the DTO does not even accept one).
    const row = await this.repo.create({
      createdBy: dto.created_by,
      orgLabel: dto.org_label,
      roleTitle: dto.role_title,
      locationLabel: dto.location_label ?? null,
      description: dto.description ?? null,
      vacancyBand: dto.vacancy_band,
      status: "draft",
    });

    const payload: PayloadInputOf<"job_posting.created"> = {
      job_posting_id: row.id,
      vacancy_band: row.vacancyBand,
      status: "draft",
      created_by: row.createdBy,
      has_location: row.locationLabel != null,
      has_description: row.description != null,
    };
    await this.events.emit(
      this.emitParams("job_posting.created", row.id, row.createdBy, payload, ctx),
    );

    return row;
  }

  list(query: ListJobPostingsQueryDto): Promise<JobPosting[]> {
    return this.repo.list(query.status);
  }

  async getOne(id: string): Promise<JobPosting> {
    const row = await this.repo.findById(id);
    if (!row) throw new NotFoundException(`Job posting ${id} not found`);
    return row;
  }

  async update(
    id: string,
    dto: UpdateJobPostingDto,
    ctx: RequestContext,
  ): Promise<JobPosting> {
    const current = await this.getOne(id);
    // closed is terminal: no edits, no status changes.
    if (current.status === "closed") {
      throw new ConflictException("Job posting is closed and cannot be edited");
    }

    // The only status transition allowed via PATCH is publish (draft -> open).
    if (dto.status === "open" && current.status !== "draft") {
      throw new ConflictException(
        `Cannot transition job posting from ${current.status} to open`,
      );
    }

    // Build the column patch and the changed-field KEY list in lockstep, so the
    // event's changed_fields exactly mirrors what we write — KEYS only, never the
    // values (no free text leaves this method).
    const patch: JobPostingUpdate = { updatedAt: new Date() };
    const changedFields: PayloadInputOf<"job_posting.updated">["changed_fields"] = [];

    if (dto.org_label !== undefined && dto.org_label !== current.orgLabel) {
      patch.orgLabel = dto.org_label;
      changedFields.push("org_label");
    }
    if (dto.role_title !== undefined && dto.role_title !== current.roleTitle) {
      patch.roleTitle = dto.role_title;
      changedFields.push("role_title");
    }
    if (dto.location_label !== undefined && dto.location_label !== current.locationLabel) {
      patch.locationLabel = dto.location_label;
      changedFields.push("location_label");
    }
    if (dto.description !== undefined && dto.description !== current.description) {
      patch.description = dto.description;
      changedFields.push("description");
    }

    let bandChanged = false;
    if (dto.vacancy_band !== undefined && dto.vacancy_band !== current.vacancyBand) {
      patch.vacancyBand = dto.vacancy_band;
      changedFields.push("vacancy_band");
      bandChanged = true;
    }

    if (dto.status === "open" && current.status !== "open") {
      patch.status = "open";
      changedFields.push("status");
    }

    if (changedFields.length === 0) {
      // Nothing actually changed (idempotent no-op edit). Don't write or emit.
      throw new BadRequestException("no effective changes to apply");
    }

    const updated = await this.repo.update(id, patch);
    if (!updated) throw new NotFoundException(`Job posting ${id} not found`);

    const payload: PayloadInputOf<"job_posting.updated"> = {
      job_posting_id: updated.id,
      changed_fields: changedFields,
      status: updated.status,
      // Only carry the band when it actually changed; otherwise null.
      vacancy_band: bandChanged ? updated.vacancyBand : null,
    };
    await this.events.emit(
      this.emitParams("job_posting.updated", updated.id, updated.createdBy, payload, ctx),
    );

    return updated;
  }

  async close(id: string, ctx: RequestContext): Promise<JobPosting> {
    const current = await this.getOne(id);
    if (current.status === "closed") {
      throw new ConflictException("Job posting is already closed");
    }
    // current.status is now narrowed to draft | open (the two closeable states).
    const previousStatus: "draft" | "open" = current.status;

    const closed = await this.repo.close(id, previousStatus, new Date());
    if (!closed) {
      // The row was closed concurrently between our read and the guarded update.
      throw new ConflictException("Job posting is already closed");
    }

    const payload: PayloadInputOf<"job_posting.closed"> = {
      job_posting_id: closed.id,
      previous_status: previousStatus,
      status: "closed",
    };
    await this.events.emit(
      this.emitParams("job_posting.closed", closed.id, closed.createdBy, payload, ctx),
    );

    return closed;
  }

  /**
   * Common emit params: ops actor, job_posting subject, tracing ids. There is no
   * ops auth in alpha, so the acting ops identity is the posting's `created_by`
   * (an opaque ops-actor uuid) — resolving it from an authenticated ops session
   * is deferred to Phase 2.
   */
  private emitParams<
    N extends "job_posting.created" | "job_posting.updated" | "job_posting.closed",
  >(
    event_name: N,
    jobPostingId: string,
    actorId: string,
    payload: PayloadInputOf<N>,
    ctx: RequestContext,
  ): EmitParams<N> {
    return {
      event_name,
      actor: { actor_type: "ops", actor_id: actorId },
      subject: { subject_type: "job_posting", subject_id: jobPostingId },
      payload,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    } as EmitParams<N>;
  }
}
