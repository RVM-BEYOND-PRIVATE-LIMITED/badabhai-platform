import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Queue } from "bullmq";

import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { RESUME_RENDER_QUEUE, type ResumeRenderJobData } from "../queue/queue.constants";
import { WorkersRepository } from "../workers/workers.repository";
import type { DeclinableAttributeKey, SetAnswerTextSourceDto } from "./worker-answer-source.dto";
import { WorkerAttributesRepository } from "./worker-attributes.repository";

/**
 * The worker's choice of WHICH text prints for one of his own free-text answers (#1485).
 *
 * WHY THIS EXISTS SEPARATELY FROM `WorkerEmploymentService.setDescriptionSource`. #1350 lets a model
 * rephrase a worker's own words and print them on the sheet an employer reads, and ADR-0039 records
 * that no test can assert the absence of a plausible-but-false sentence — only the worker knows
 * whether one is true. #1354 gave him that say PER EMPLOYMENT. A FRESHER HAS NO EMPLOYMENT: his
 * Zone 4 is his ITI training, assembled from pack answers, and its one worker-written segment
 * (`iti_project_work`) could be rewritten with no way for him to see it and no way to refuse. He is
 * also the worker with the least else on his page, so that one sentence carries the most weight.
 *
 * #1476 closed the SEEING half. This closes the REFUSING half, which is the one that needed a
 * column, and the decision lives on `worker_attributes` rather than `worker_employment_role`
 * because an answer — not an employment row — is what there is to address.
 */
@Injectable()
export class WorkerAnswerSourceService {
  private readonly logger = new Logger(WorkerAnswerSourceService.name);

  constructor(
    private readonly attributes: WorkerAttributesRepository,
    private readonly workers: WorkersRepository,
    private readonly events: EventsService,
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly renderQueue: Queue<ResumeRenderJobData>,
  ) {}

  /**
   * Record the choice, then re-render, because a decision that does not reach the PDF is not one.
   *
   * 404 ON ZERO ROWS, NEVER 403. Zero is what the repository returns when the key is not this
   * worker's answer AND when it is nobody's — the two are indistinguishable by design, so the
   * status code cannot become a read of another worker's profile. Same shape as
   * `setDescriptionSource`.
   */
  async setTextSource(
    workerId: string,
    attributeKey: DeclinableAttributeKey,
    dto: SetAnswerTextSourceDto,
    ctx: RequestContext,
  ): Promise<{ answers_updated: number }> {
    const declined = dto.source === "own_words";
    const updated = await this.attributes.setTextPolishDeclined(workerId, attributeKey, declined);
    if (updated === 0) {
      // The key is in the allow-list, so reaching here means he has no such answer — he was never
      // asked it (a senior is not asked the fresher questions) or has not answered it yet.
      throw new NotFoundException(`Answer ${attributeKey} not found`);
    }

    await this.events.emit({
      event_name: "worker.answer_text_source_set",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      // NEITHER TEXT TRAVELS — not his sentence and not the rewrite of it. The whole premise of
      // this route is that one of the two may be false, and an audit trail does not need the words
      // to record that he was able to choose. `attribute_key` is a pack question key, which is
      // closed vocabulary on the same shape the column enforces.
      payload: { worker_id: workerId, attribute_key: attributeKey, source: dto.source },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    // The key and the choice only — never either version of the sentence.
    this.logger.log(
      `answer text source set to ${dto.source} for worker ${workerId} (${attributeKey})`,
    );
    await this.enqueueRerender(workerId, ctx);
    return { answers_updated: updated };
  }

  /**
   * Best-effort: a queue that is down must not fail the write the worker just made.
   *
   * The same contract, and the same reasoning, as `WorkerEmploymentService.enqueueRerender` — a
   * worker with no résumé yet is the ordinary case on this path and there is nothing to re-render.
   */
  private async enqueueRerender(workerId: string, ctx: RequestContext): Promise<void> {
    try {
      const latest = await this.workers.latestResume(workerId);
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
