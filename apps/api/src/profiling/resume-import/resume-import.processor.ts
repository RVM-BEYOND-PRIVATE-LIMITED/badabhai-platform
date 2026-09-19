import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";

import {
  RESUME_IMPORT_PARSE_QUEUE,
  type ResumeImportParseJobData,
} from "../../queue/queue.constants";
import { Logger } from "@nestjs/common";
import { ResumeParseService } from "./resume-parse.service";
import { ResumeRouteService } from "./resume-route.service";
import { ResumeSummaryService } from "./resume-summary.service";

/**
 * The BullMQ ADAPTER for a résumé import — read the document, then route the worker.
 *
 * TWO SERVICES, ONE JOB, AND THE ORDER IS THE CONTRACT. RI-3 reads and gates; RI-4 decides,
 * stages and SETTLES. One job means the document is read at most once (`markParsing` is the
 * lock) and the decision follows it.
 *
 * RI-SUMMARY RUNS BESIDE THE ROUTE, NEVER IN FRONT OF IT. The second LLM call re-reads the
 * same document for one Hinglish line ({role} + {tajurba} + {summary}) for Langfuse
 * verification. Backend-only in this slice: it writes nothing, emits nothing, and shows
 * nothing in chat. Best-effort by construction — a throw here must never cost the worker
 * their route — so it is wrapped, logged PII-free, and ignored.
 *
 * ONE JOB WAS NOT ENOUGH ON ITS OWN (amended 2026-09-15). The first cut had the two services
 * write `parsed` and the route in two separate updates inside this one job, and a client polling
 * between them read a terminal `parsed` beside a null route and sent a form-routed worker to the
 * chat. The job boundary never made two statements atomic. `settleParsed` now writes status and
 * route in ONE guarded UPDATE, with its event on the same transaction, so no reader can see a
 * `parsed` row without its route.
 *
 * RETRIES ARE SAFE AND NEVER RE-BILL. A throw after the AI call — a suggestion payload that
 * could not be sealed, a database error inside the settle — rolls the settle back and leaves
 * the row `parsing`. BullMQ redelivers; the parse service sees a row past `uploaded` and returns
 * `already_settled` without reading the document again, the route service settles nothing, and
 * this job completes with `route: null`. The row then waits for a sweep (ADR-0041 §7) rather
 * than a second charge.
 *
 * NO BUSINESS LOGIC LIVES HERE (CLAUDE.md §4). The only fact this class contributes is the one
 * only BullMQ knows — the job payload — and that a thrown error is how failure is reported.
 *
 * THE WORKER IS NEVER WAITING ON THIS. `POST /profiling/resume-import` returned the moment the
 * row was registered; the client polls `GET :importId`. A job that dies for good leaves the
 * import short of a route and the worker carries on into the chat, which is ruling D9's
 * "never a dead end" — served by the client, not by this job succeeding.
 */
@Processor(RESUME_IMPORT_PARSE_QUEUE)
export class ResumeImportProcessor extends WorkerHost {
  private readonly logger = new Logger(ResumeImportProcessor.name);

  constructor(
    private readonly parse: ResumeParseService,
    private readonly routing: ResumeRouteService,
    private readonly summary: ResumeSummaryService,
  ) {
    super();
  }

  async process(
    job: Job<ResumeImportParseJobData>,
  ): Promise<{ import_id: string; route: string | null }> {
    const { workerId, importId, correlationId, requestId } = job.data;
    const ctx = { correlationId, requestId };

    const draft = await this.parse.parse(workerId, importId, ctx);
    // RI-summary, best-effort and never blocking: the Langfuse trace is the verification
    // surface in this slice. A failure here costs nothing — the route below still settles.
    if (draft.status === "parsed") {
      try {
        await this.summary.summarize(workerId, draft.storageKey, draft.mime, ctx);
      } catch (error) {
        // PII-FREE: an error message, never document text. The summary is observability,
        // not the route — failing closed here means continuing to the route, not stopping.
        this.logger.warn(
          `résumé summary skipped for import ${importId}: ${(error as Error).message}`,
        );
      }
    }
    const routed = await this.routing.route(workerId, draft, ctx);

    // IDS AND A CLOSED-SET ROUTE. This value is BullMQ's job result and is kept in Redis; it
    // must carry no more than the event already does. `null` when THIS delivery settled no
    // route — a failed parse, or a redelivery that found the row already past `parsing` — so
    // the job result never claims a route the row does not show.
    return { import_id: importId, route: routed?.route ?? null };
  }
}
