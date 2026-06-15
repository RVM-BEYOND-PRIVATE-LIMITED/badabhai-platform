import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Job } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { JobsRepository, type JobListFilter } from "./jobs.repository";
import type {
  ActivateJobDto,
  BoostJobDto,
  CloseJobDto,
  CreateJobDto,
  ListJobsDto,
  RecordApplicantsDto,
} from "./jobs.dto";

/**
 * PACE dials — Phase-2 Wave-1 defaults. Config tables stay OUT of the schema by
 * design; these named constants can move to env (ServerConfig) later without a
 * migration. They are NOT secrets and carry no PII.
 */
// Applicant quota stamped at activation = vacancyCount × this (when no override).
const WAVE1_APPLICANT_MULTIPLIER = 3;
// Default intro window (days) added to now() at activation when introDays is absent.
const DEFAULT_INTRO_DAYS = 21;

/**
 * Job lifecycle service (Phase-2 Job entity — the `posting_fee` billable object).
 *
 * Owns the state machine (draft → active ⇄ paused → closed) and emits a
 * validated event for every important transition via EventsService.
 *
 * PRIVACY (invariant): event payloads carry ONLY opaque ids/slugs/counts/enums.
 * The job `title` and the payer identity never appear in an event payload or a
 * log line. `payer_id` is an opaque UUID (no FK, no payers table).
 */
@Injectable()
export class JobsService {
  constructor(
    private readonly jobs: JobsRepository,
    private readonly events: EventsService,
  ) {}

  /** POST /jobs — create a draft and emit `job.created`. */
  async create(dto: CreateJobDto, ctx: RequestContext): Promise<Job> {
    const job = await this.jobs.create({
      payerId: dto.payerId,
      title: dto.title,
      roleIds: dto.roleIds,
      vacancyCount: dto.vacancyCount,
      domainId: dto.domainId ?? null,
      city: dto.city ?? null,
      locationLat: dto.locationLat ?? null,
      locationLng: dto.locationLng ?? null,
      maxTravelKm: dto.maxTravelKm ?? null,
      minExperienceYears: dto.minExperienceYears ?? null,
      maxExperienceYears: dto.maxExperienceYears ?? null,
      payMin: dto.payMin ?? null,
      payMax: dto.payMax ?? null,
      neededBy: dto.neededBy ?? null,
      status: "draft",
    });

    await this.events.emit({
      event_name: "job.created",
      actor: { actor_type: "payer", actor_id: job.payerId },
      subject: { subject_type: "job", subject_id: job.id },
      payload: {
        job_id: job.id,
        payer_id: job.payerId,
        role_ids: job.roleIds,
        vacancy_count: job.vacancyCount,
        // NOTE: `title` is deliberately absent — payer free-text never enters events.
      },
      idempotencyKey: `job.created:${job.id}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return job;
  }

  /** GET /jobs — ops read with optional filters + pagination. */
  async list(query: ListJobsDto): Promise<Job[]> {
    const filter: JobListFilter = {
      status: query.status,
      payerId: query.payerId,
      limit: query.limit,
      offset: query.offset,
    };
    return this.jobs.list(filter);
  }

  /** GET /jobs/:id — 404 if missing. */
  async getOrThrow(id: string): Promise<Job> {
    const job = await this.jobs.findById(id);
    if (!job) throw new NotFoundException(`Job ${id} not found`);
    return job;
  }

  /** POST /jobs/:id/activate — draft → active ONLY. Stamps quota + intro window. */
  async activate(id: string, dto: ActivateJobDto, ctx: RequestContext): Promise<Job> {
    const job = await this.getOrThrow(id);
    if (job.status !== "draft") {
      throw new ConflictException(`cannot activate a job in status '${job.status}'`);
    }

    const now = new Date();
    const applicantQuota = dto.applicantQuota ?? job.vacancyCount * WAVE1_APPLICANT_MULTIPLIER;
    const introDays = dto.introDays ?? DEFAULT_INTRO_DAYS;
    const introExpiresAt = new Date(now.getTime() + introDays * MS_PER_DAY);

    const updated = await this.requireUpdate(id, {
      status: "active",
      applicantQuota,
      introExpiresAt,
      postingFeeInr: dto.postingFeeInr ?? job.postingFeeInr,
      activatedAt: now,
    });

    await this.events.emit({
      event_name: "job.activated",
      actor: { actor_type: "payer", actor_id: updated.payerId },
      subject: { subject_type: "job", subject_id: updated.id },
      payload: {
        job_id: updated.id,
        payer_id: updated.payerId,
        vacancy_count: updated.vacancyCount,
        applicant_quota: applicantQuota,
        posting_fee_inr: updated.postingFeeInr ?? null,
        intro_expires_at: introExpiresAt.toISOString(),
      },
      idempotencyKey: `job.activated:${updated.id}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return updated;
  }

  /** POST /jobs/:id/pause — active → paused ONLY (manual). Repeatable: no key. */
  async pause(id: string, ctx: RequestContext): Promise<Job> {
    const job = await this.getOrThrow(id);
    if (job.status !== "active") {
      throw new ConflictException(`cannot pause a job in status '${job.status}'`);
    }

    const updated = await this.requireUpdate(id, {
      status: "paused",
      pauseReason: "manual",
      pausedAt: new Date(),
    });

    await this.emitPaused(updated, "manual", ctx);
    return updated;
  }

  /** POST /jobs/:id/resume — paused → active ONLY. Repeatable: no key. */
  async resume(id: string, ctx: RequestContext): Promise<Job> {
    const job = await this.getOrThrow(id);
    if (job.status !== "paused") {
      throw new ConflictException(`cannot resume a job in status '${job.status}'`);
    }

    const updated = await this.requireUpdate(id, {
      status: "active",
      pauseReason: null,
      pausedAt: null,
    });

    await this.events.emit({
      event_name: "job.resumed",
      actor: { actor_type: "payer", actor_id: updated.payerId },
      subject: { subject_type: "job", subject_id: updated.id },
      payload: {
        job_id: updated.id,
        payer_id: updated.payerId,
        applicants_received_count: updated.applicantsReceivedCount,
        applicant_quota: updated.applicantQuota ?? null,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return updated;
  }

  /**
   * POST /jobs/:id/applicants — INTERIM ops/test seam. Records received applicants
   * until the worker feed + `application.submitted` lands. Requires status=active.
   *
   * The increment itself emits NO event; it only emits `job.paused`
   * (reason=quota_reached) if the increment crosses the stamped applicant_quota,
   * auto-transitioning the job to paused.
   */
  async recordApplicants(
    id: string,
    dto: RecordApplicantsDto,
    ctx: RequestContext,
  ): Promise<Job> {
    const job = await this.getOrThrow(id);
    if (job.status !== "active") {
      throw new ConflictException(`cannot record applicants for a job in status '${job.status}'`);
    }

    const received = job.applicantsReceivedCount + dto.count;
    const quotaReached = job.applicantQuota !== null && received >= job.applicantQuota;

    const updated = await this.requireUpdate(id, {
      applicantsReceivedCount: received,
      ...(quotaReached
        ? { status: "paused" as const, pauseReason: "quota_reached" as const, pausedAt: new Date() }
        : {}),
    });

    if (quotaReached) {
      await this.emitPaused(updated, "quota_reached", ctx);
    }

    return updated;
  }

  /** POST /jobs/:id/boost — draft/active/paused only (409 if closed). Repeatable: no key. */
  async boost(id: string, dto: BoostJobDto, ctx: RequestContext): Promise<Job> {
    const job = await this.getOrThrow(id);
    if (job.status === "closed") {
      throw new ConflictException(`cannot boost a job in status '${job.status}'`);
    }

    const now = new Date();
    const boostExpiresAt =
      dto.boostDurationDays !== undefined
        ? new Date(now.getTime() + dto.boostDurationDays * MS_PER_DAY)
        : null;

    const updated = await this.requireUpdate(id, {
      boostTier: dto.boostTier,
      boostedAt: now,
      boostExpiresAt,
    });

    await this.events.emit({
      event_name: "job.boosted",
      actor: { actor_type: "payer", actor_id: updated.payerId },
      subject: { subject_type: "job", subject_id: updated.id },
      payload: {
        job_id: updated.id,
        payer_id: updated.payerId,
        boost_tier: updated.boostTier,
        boost_expires_at: boostExpiresAt ? boostExpiresAt.toISOString() : null,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return updated;
  }

  /** POST /jobs/:id/close — draft/active/paused → closed (409 if already closed). */
  async close(id: string, dto: CloseJobDto, ctx: RequestContext): Promise<Job> {
    const job = await this.getOrThrow(id);
    if (job.status === "closed") {
      throw new ConflictException(`cannot close a job in status '${job.status}'`);
    }

    const updated = await this.requireUpdate(id, {
      status: "closed",
      closedAt: new Date(),
    });

    await this.events.emit({
      event_name: "job.closed",
      actor: { actor_type: "payer", actor_id: updated.payerId },
      subject: { subject_type: "job", subject_id: updated.id },
      payload: {
        job_id: updated.id,
        payer_id: updated.payerId,
        reason: dto.reason,
        applicants_received_count: updated.applicantsReceivedCount,
      },
      idempotencyKey: `job.closed:${updated.id}`,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return updated;
  }

  /**
   * Emit `job.paused`. UNKEYED on purpose — pause is legitimately repeatable
   * (manual re-pause) and the auto quota-reached pause should always record.
   */
  private emitPaused(
    job: Job,
    reason: "manual" | "quota_reached",
    ctx: RequestContext,
  ): Promise<unknown> {
    return this.events.emit({
      event_name: "job.paused",
      actor: { actor_type: "payer", actor_id: job.payerId },
      subject: { subject_type: "job", subject_id: job.id },
      payload: {
        job_id: job.id,
        payer_id: job.payerId,
        reason,
        applicants_received_count: job.applicantsReceivedCount,
        applicant_quota: job.applicantQuota ?? null,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }

  /**
   * Apply an update and assert a row came back. A missing row here means the job
   * vanished between the read and the write (rare) — surface it as a 404.
   */
  private async requireUpdate(id: string, patch: Partial<Parameters<JobsRepository["update"]>[1]>) {
    const updated = await this.jobs.update(id, patch);
    if (!updated) throw new NotFoundException(`Job ${id} not found`);
    return updated;
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
