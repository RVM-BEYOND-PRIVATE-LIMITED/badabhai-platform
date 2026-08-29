import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Queue } from "bullmq";

import { PiiCryptoService } from "../common/pii-crypto.service";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { RESUME_RENDER_QUEUE, type ResumeRenderJobData } from "../queue/queue.constants";
import { WorkersRepository } from "../workers/workers.repository";
import type { SetDescriptionSourceDto, SetMyEmploymentDto } from "./worker-employment.dto";
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
      // THE LINE v1 SAID WOULD BE THE ONLY ONE TO CHANGE, changing (#1328).
      //
      // The shorthand still produces exactly what it produced before — one role whose dates ARE
      // the employment's — so a client that predates promotion capture renders byte-identically.
      // `roles` is taken in the order the worker gave it, which is display order, most recent
      // first; deriving it from the dates would reshuffle stints between renders and make every
      // regenerated PDF a false diff, exactly as the employment `sortOrder` comment says.
      roles:
        e.roles !== undefined
          ? e.roles.map((r) => ({
              roleLabel: r.role_label,
              startYm: r.start_ym,
              endYm: r.end_ym,
              workDone: r.work_done,
            }))
          : [
              {
                roleLabel: e.role_label as string,
                startYm: e.start_ym,
                endYm: e.end_ym,
                workDone: e.work_done,
              },
            ],
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

  /**
   * Record which text prints as one employment's work line (#1354).
   *
   * 404 ON ZERO ROWS, and it is not laziness about the status code. The employment id comes
   * from the client; a 403 would confirm that somebody else's id EXISTS, which is an existence
   * oracle over another worker's history. Not-found is the honest answer to "you have no such
   * employment" whether the row belongs to someone else or to nobody.
   *
   * RE-RENDERS, because the choice only means anything once it reaches the PDF the worker hands
   * over. Best-effort on the same terms as an edit: a queue that is down must not fail the
   * decision, and the previous PDF keeps serving until the next render picks it up.
   */
  async setDescriptionSource(
    workerId: string,
    employmentId: string,
    dto: SetDescriptionSourceDto,
    ctx: RequestContext,
  ): Promise<{ stints_updated: number }> {
    const declined = dto.source === "own_words";
    const updated = await this.employment.setPolishDeclined(workerId, employmentId, declined);
    if (updated === 0) {
      throw new NotFoundException(`Employment ${employmentId} not found`);
    }

    await this.events.emit({
      event_name: "worker.employment_recorded",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      // PII-FREE, and deliberately the SHAPE of the existing employment event rather than a new
      // one: what happened is that this worker's history changed in a way the sheet renders.
      // The counts say how much; nothing says which employer or what either text said.
      payload: {
        worker_id: workerId,
        employer_count: 1,
        durations_stated: 0,
        replaced_existing: true,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    // Counts and the choice only — never the employer, never either version of the text.
    this.logger.log(
      `description source set to ${dto.source} for worker ${workerId}: ${updated} stint(s)`,
    );
    await this.enqueueRerender(workerId, ctx);
    return { stints_updated: updated };
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
