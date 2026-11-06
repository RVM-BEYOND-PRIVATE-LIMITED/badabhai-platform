import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { WorkerAdminOverrideFactKey } from "@badabhai/db";
import { DevicesRepository } from "../../auth/devices.repository";
import type { RequestContext } from "../../common/request-context";
import { WorkerSkillsService } from "../../match/worker-skills.service";
import { PushEnqueuer } from "../../push/push-enqueuer.service";
import {
  CANDIDATE_INDEX_PROJECT_JOB,
  CANDIDATE_INDEX_QUEUE,
  RESUME_GENERATE_QUEUE,
  RESUME_RENDER_QUEUE,
  type ResumeGenerateJobData,
  type ResumeRenderJobData,
} from "../../queue/queue.constants";
import { WorkersRepository } from "../../workers/workers.repository";

/**
 * #2561 PR 3 — the AFTER-SAVE effects of one admin correction (ADR-0062 §3.10 / §4).
 *
 * Everything here runs AFTER the correction transaction has committed, and every step is
 * best-effort: a Redis/provider hiccup must never roll back a correction the admin was told
 * succeeded. The stores are already in their corrected state; these effects make the derived
 * surfaces converge:
 *
 *   - the candidate read table re-projects for THIS worker;
 *   - the groups that feed matching rebuild `worker_skill` / tenure / reach;
 *   - snapshot fields (trade, role, skills, total experience) queue a NEW résumé version with
 *     `generation_trigger='admin_edit'`; every other group redraws the latest résumé in place;
 *   - the worker gets one faceless push (no value, no reason, no admin identity).
 *
 * The fact key is safe to log; a corrected value and the admin's reason are not.
 */
@Injectable()
export class AdminCorrectionEffectsService {
  private readonly logger = new Logger(AdminCorrectionEffectsService.name);

  /** ADR-0062 §4 — these change the résumé SNAPSHOT, so they mint a new `admin_edit` version. */
  private static readonly SNAPSHOT_FACTS: ReadonlySet<WorkerAdminOverrideFactKey> = new Set([
    "trade",
    "role",
    "skills",
    "experience",
  ]);

  /** The groups that feed the matching projection. */
  private static readonly MATCH_FACTS: ReadonlySet<WorkerAdminOverrideFactKey> = new Set([
    "trade",
    "role",
    "skills",
    "experience",
    "work_history",
    "secondary_roles",
  ]);

  constructor(
    private readonly workers: WorkersRepository,
    private readonly workerSkills: WorkerSkillsService,
    private readonly devices: DevicesRepository,
    private readonly push: PushEnqueuer,
    @InjectQueue(CANDIDATE_INDEX_QUEUE) private readonly indexQueue: Queue,
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly renderQueue: Queue<ResumeRenderJobData>,
    @InjectQueue(RESUME_GENERATE_QUEUE)
    private readonly generateQueue: Queue<ResumeGenerateJobData>,
  ) {}

  /**
   * Run every after-save effect for one committed correction/revert. Never throws.
   * `sourceEventId` is the domain event's id (the push dedupe key + audit link).
   */
  async afterCorrection(input: {
    workerId: string;
    factKey: WorkerAdminOverrideFactKey;
    eventName: "admin.candidate_field_corrected" | "admin.candidate_field_reverted";
    sourceEventId: string;
    ctx: RequestContext;
  }): Promise<void> {
    const { workerId, factKey, ctx } = input;

    await this.reproject(workerId);

    if (AdminCorrectionEffectsService.MATCH_FACTS.has(factKey)) {
      try {
        await this.workerSkills.rebuildQuietly(workerId, ctx);
      } catch (err) {
        this.logger.warn(
          `matching rebuild after ${input.eventName} ${factKey} failed for worker ${workerId} ` +
            `(${err instanceof Error ? err.name : "unknown"}); the nightly backfill will repair it`,
        );
      }
    }

    if (AdminCorrectionEffectsService.SNAPSHOT_FACTS.has(factKey)) {
      await this.queueAdminEditResume(workerId, ctx);
    } else {
      await this.rerenderLatest(workerId, ctx);
    }

    await this.pushWorker(input);
  }

  private async reproject(workerId: string): Promise<void> {
    try {
      await this.indexQueue.add(
        CANDIDATE_INDEX_PROJECT_JOB,
        { workerId },
        { removeOnComplete: true, removeOnFail: true },
      );
    } catch (err) {
      this.logger.warn(
        `candidate-index re-projection after a correction failed for worker ${workerId} ` +
          `(${err instanceof Error ? err.message : "unknown"}); the poll will converge`,
      );
    }
  }

  /** Snapshot fields: a NEW history entry with the `admin_edit` trigger. */
  private async queueAdminEditResume(workerId: string, ctx: RequestContext): Promise<void> {
    try {
      const profile = await this.workers.latestProfile(workerId);
      if (!profile) return;
      await this.generateQueue.add(
        "generate",
        {
          workerId,
          profileId: profile.id,
          trigger: "admin_edit",
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
        },
        { removeOnComplete: true, removeOnFail: true },
      );
    } catch (err) {
      this.logger.warn(
        `admin-edit resume generation not queued for worker ${workerId} ` +
          `(${err instanceof Error ? err.message : "unknown"})`,
      );
    }
  }

  /** Live fields: redraw the latest résumé in place (same id + version + object key). */
  private async rerenderLatest(workerId: string, ctx: RequestContext): Promise<void> {
    try {
      const latest = await this.workers.latestResume(workerId);
      if (!latest) return;
      await this.renderQueue.add(
        "render",
        {
          resumeId: latest.id,
          workerId,
          force: true,
          failClosed: false,
          correlationId: ctx.correlationId,
          requestId: ctx.requestId,
        },
        { removeOnComplete: true, removeOnFail: true },
      );
    } catch (err) {
      this.logger.warn(
        `résumé re-render after a correction not queued for worker ${workerId} ` +
          `(${err instanceof Error ? err.message : "unknown"})`,
      );
    }
  }

  /** One faceless push per save. The copy lives in the notification template; no payload rides. */
  private async pushWorker(input: {
    workerId: string;
    eventName: "admin.candidate_field_corrected" | "admin.candidate_field_reverted";
    sourceEventId: string;
  }): Promise<void> {
    try {
      const targets = await this.devices.listPushTargets(input.workerId);
      if (targets.length === 0) return;
      await this.push.enqueue({
        workerId: input.workerId,
        sourceEventId: input.sourceEventId,
        eventName: input.eventName,
        deviceIds: targets.map((target) => target.id),
      });
    } catch (err) {
      this.logger.warn(
        `correction push not queued for worker ${input.workerId} ` +
          `(${err instanceof Error ? err.message : "unknown"})`,
      );
    }
  }
}
