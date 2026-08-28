import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Queue } from "bullmq";

import { PiiCryptoService } from "../common/pii-crypto.service";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { RESUME_RENDER_QUEUE, type ResumeRenderJobData } from "../queue/queue.constants";
import { WorkersRepository } from "../workers/workers.repository";
import type { SetMyEmploymentDto } from "./worker-employment.dto";
import { WorkerEmploymentRepository } from "./worker-employment.repository";

/**
 * Records the worker's own work history from the post-interview form (R4 Q1).
 *
 * THE EMPLOYER NAME NEVER PASSES THROUGH THE AI SERVICE. It is typed by the worker, encrypted
 * here, and written straight to Postgres — the owner ruling behind `worker_employment`. The
 * pseudonymisation gateway's employer mask is unchanged and unaffected: nothing on this path
 * builds a prompt.
 *
 * ENCRYPT BEFORE THE DB TOUCH, exactly as `WorkersService.setFullName` does. The repository
 * takes ciphertext and cannot encrypt, so there is no path on which a plaintext employer name
 * reaches a column.
 */
@Injectable()
export class WorkerEmploymentService {
  private readonly logger = new Logger(WorkerEmploymentService.name);

  constructor(
    private readonly employment: WorkerEmploymentRepository,
    private readonly workers: WorkersRepository,
    private readonly pii: PiiCryptoService,
    private readonly events: EventsService,
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly renderQueue: Queue<ResumeRenderJobData>,
  ) {}

  async replaceForWorker(
    workerId: string,
    dto: SetMyEmploymentDto,
    ctx: RequestContext,
  ): Promise<{ worker_id: string; employer_count: number }> {
    const worker = await this.workers.findById(workerId);
    if (!worker) throw new NotFoundException(`Worker ${workerId} not found`);

    const rows = dto.employments.map((e) => ({
      employerNameEnc: this.pii.encrypt(e.employer_name),
      employerCity: e.employer_city,
      employerState: e.employer_state,
      startYm: e.start_ym,
      endYm: e.end_ym,
      // §11 #3, AND IT IS DERIVED RATHER THAN ASKED. "Kuch saal" has no start month, and the
      // sheet must print the literal "duration not stated" instead of estimating one. The
      // schema's `we_duration_stated_chk` refuses `true` without a start, so deriving it from
      // the presence of a start month is the only value that can be both honest and legal.
      durationStated: e.start_ym !== null,
      role: {
        roleLabel: e.role_label,
        // ONE ROLE PER EMPLOYMENT in v1, so its dates ARE the employment's. When promotion
        // capture lands the two diverge and §11 #14 already renders that — this is the only
        // line that changes.
        startYm: e.start_ym,
        endYm: e.end_ym,
        workDone: e.work_done,
      },
    }));

    const { replacedExisting } = await this.employment.replaceForWorker(workerId, rows);

    await this.events.emit({
      event_name: "worker.employment_recorded",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      // PII-FREE: shape only. The employer name is the feature and is exactly what may not
      // travel; the city does not travel either, because a city plus a worker id plus a date
      // range narrows a person and the spine needs none of it.
      payload: {
        worker_id: workerId,
        employer_count: rows.length,
        durations_stated: rows.filter((r) => r.durationStated).length,
        replaced_existing: replacedExisting,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    // Counts only — never an employer name, a city or a date.
    this.logger.log(
      `employment recorded for worker ${workerId}: ${rows.length} employer(s), ` +
        `${rows.filter((r) => r.durationStated).length} dated`,
    );

    // Zone 4 is baked into the PDF at render time, so an EDIT must re-render in place or the
    // worker keeps downloading a sheet with his old history on it — the same reason a name
    // change re-renders. failClosed:false: adding history is not a REMOVAL, so a failed render
    // leaves the previous PDF in service rather than 409-ing a résumé he had a second ago.
    await this.enqueueRerender(workerId, ctx);

    return { worker_id: workerId, employer_count: rows.length };
  }

  /** Best-effort: a queue that is down must not fail the write the worker just made. */
  private async enqueueRerender(workerId: string, ctx: RequestContext): Promise<void> {
    try {
      const latest = await this.workers.latestResume(workerId);
      // No résumé yet - the common case, since the form comes straight after the interview and
      // before the first generate. Nothing to re-render; the first render picks the history up.
      if (!latest) return;
      await this.renderQueue.add("render", {
        resumeId: latest.id,
        workerId,
        force: true,
        failClosed: false,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    } catch (err) {
      this.logger.warn(
        `could not enqueue resume re-render for worker ${workerId} (${
          err instanceof Error ? err.message : "unknown"
        })`,
      );
    }
  }
}
