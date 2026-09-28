import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import type { Queue } from "bullmq";

import type { RequestContext } from "../common/request-context";
import { RESUME_RENDER_QUEUE, type ResumeRenderJobData } from "../queue/queue.constants";
import { WorkersRepository } from "../workers/workers.repository";

/**
 * A FORCED, IN-PLACE re-render of the worker's LATEST résumé after a change that affects only
 * PRESENTATION — the cosmetic direction of `WorkersService.enqueueResumeRerender`, as a seam any
 * service can inject.
 *
 * WHY A SHARED SEAM (#1801). That method is private to `WorkersService`, and six services
 * (`WorkerEmployment`, `WorkerLanguages`, `WorkerPreferences`, `WorkerQualifications`,
 * `WorkerAnswerSource`, `GeneralForm`) each carry their own private copy of this same cosmetic
 * call. The résumé-skin change needed it a seventh time; this is the one place it now lives, and
 * the existing copies can move onto it one at a time (they are unchanged here, deliberately —
 * out of this issue's scope). The ERASURE direction (`failClosed`, with its fan-out over every
 * older PDF) stays in `WorkersService`, where the PII it erases is owned.
 *
 * THE JOB IS EXACTLY THE ONE THOSE COPIES ENQUEUE: the latest résumé's id, `force: true` (the
 * processor skips an already-rendered row otherwise), `failClosed: false` (a cosmetic render
 * that fails keeps the previous PDF in service rather than 409-ing a résumé the worker had a
 * second ago), and the request's tracing ids. Refs only — no PII is enqueued.
 *
 * LLM-FREE AND VERSION-STABLE: the render reads the stored snapshot and live tables, never the AI
 * service, and overwrites the same object key — no new résumé version, no `resume.generated`.
 *
 * BEST-EFFORT: a lookup or queue failure is logged (worker id and reason only) and swallowed. The
 * write that triggered the re-render is already durable and must never fail on the queue.
 */
@Injectable()
export class ResumeRerenderService {
  private readonly logger = new Logger(ResumeRerenderService.name);

  constructor(
    private readonly workers: WorkersRepository,
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly renderQueue: Queue<ResumeRenderJobData>,
  ) {}

  /**
   * Queue the cosmetic re-render of the worker's latest résumé. Returns the résumé id queued, or
   * null when they have no résumé yet (nothing to re-render — their first generation picks the change
   * up) or the enqueue failed. Never throws.
   */
  async enqueueLatest(workerId: string, ctx: RequestContext): Promise<string | null> {
    try {
      const latest = await this.workers.latestResume(workerId);
      if (!latest) return null;
      await this.renderQueue.add("render", {
        resumeId: latest.id,
        workerId,
        force: true,
        failClosed: false,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
      return latest.id;
    } catch (err) {
      this.logger.warn(
        `could not enqueue resume re-render for worker ${workerId} (${
          err instanceof Error ? err.message : "unknown"
        })`,
      );
      return null;
    }
  }
}
