import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Queue } from "bullmq";

import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { RESUME_RENDER_QUEUE, type ResumeRenderJobData } from "../queue/queue.constants";
import { WorkersRepository } from "../workers/workers.repository";
import {
  SetMyLanguagesSchema,
  type LanguageEntryDto,
  type MyLanguagesResponse,
  type SetMyLanguagesDto,
} from "./worker-languages.dto";
import { WorkerLanguagesRepository } from "./worker-languages.repository";

/**
 * Records how the worker knows each language they list (migration 0110, ADR-0042 D9 / Layer A (b)).
 *
 * ═══ WHAT THIS ADDS TO THE SHEET ═══
 *
 * The Languages row has only ever printed a bare list of slugs from the `languages` attribute:
 * "Hindi, English". It could not say that the worker reads English but does not speak it, or
 * writes Haryanvi but cannot read it. This service owns the richer rows; the sheet prefers them
 * per-field (`tradeSheet.qualification?.languages ?? preferences.languages`) and falls back to
 * the attribute for every worker who has not used this page.
 *
 * ═══ NOTHING HERE TOUCHES A MODEL ═══
 *
 * Closed slugs plus three booleans. No prompt is built, no pseudonymisation boundary is in the
 * path, and `resume-qualification-rows.ts` composes the printed line from reviewed words alone.
 */
@Injectable()
export class WorkerLanguagesService {
  private readonly logger = new Logger(WorkerLanguagesService.name);

  constructor(
    private readonly languages: WorkerLanguagesRepository,
    private readonly workers: WorkersRepository,
    private readonly events: EventsService,
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly renderQueue: Queue<ResumeRenderJobData>,
  ) {}

  async replaceForWorker(
    workerId: string,
    dto: SetMyLanguagesDto,
    ctx: RequestContext,
  ): Promise<{ worker_id: string; language_count: number }> {
    const worker = await this.workers.findById(workerId);
    if (!worker) throw new NotFoundException(`Worker ${workerId} not found`);

    const { languagesWritten, replacedExisting } = await this.languages.replaceForWorker(
      workerId,
      dto.languages.map((l) => ({
        language: l.language,
        canSpeak: l.can_speak,
        canRead: l.can_read,
        canWrite: l.can_write,
      })),
    );

    await this.events.emit({
      event_name: "worker.languages_recorded",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      // COUNTS, NEVER THE LANGUAGES. A language is not an identifier on its own, but the SET —
      // a regional language plus a worker id — narrows a person considerably, and the spine needs
      // to know the page was answered rather than what it said. The same rule
      // `worker.qualifications_recorded` and `worker.preferences_recorded` follow.
      payload: {
        worker_id: workerId,
        language_count: languagesWritten,
        replaced_existing: replacedExisting,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    // Counts only — never a language slug.
    this.logger.log(
      `languages recorded for worker ${workerId}: ${languagesWritten} language(s)` +
        (replacedExisting ? ", replaced existing rows" : ""),
    );

    await this.enqueueRerender(workerId, ctx);

    return { worker_id: workerId, language_count: languagesWritten };
  }

  /**
   * The caller's stored language rows, in the PUT's own entry shapes (#1504).
   *
   * Each row is passed through the PUT schema; a row that no longer parses (a slug retired from
   * the dictionary) is withheld and counted rather than returned, so an unedited save round-trips
   * instead of 400-ing. See {@link MyLanguagesResponse} for why the client must not re-send a
   * list while `partial` is true.
   *
   * NO EVENT (a read changes nothing) and a counts-only log line.
   */
  async getForWorker(workerId: string): Promise<MyLanguagesResponse> {
    const stored = await this.languages.loadForResume(workerId);

    const languages: LanguageEntryDto[] = [];
    let droppedCount = 0;
    for (const row of stored) {
      const parsed = SetMyLanguagesSchema.safeParse({
        languages: [
          {
            language: row.language,
            can_speak: row.canSpeak,
            can_read: row.canRead,
            can_write: row.canWrite,
          },
        ],
      });
      if (parsed.success && parsed.data.languages?.[0]) languages.push(parsed.data.languages[0]);
      else droppedCount += 1;
    }

    this.logger.log(
      `languages read for worker ${workerId}: ${languages.length} row(s), ${droppedCount} withheld`,
    );
    return { languages, partial: droppedCount > 0, dropped_count: droppedCount };
  }

  /**
   * Best-effort: a queue that is down must not fail the write the worker just made.
   *
   * `failClosed: false` because ADDING rows is not a REMOVAL — a failed render leaves the
   * previous PDF in service rather than 409-ing a résumé the worker had a second ago. The same
   * call, on the same terms, as the qualifications writer.
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
