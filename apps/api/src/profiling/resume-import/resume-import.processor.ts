import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";

import {
  RESUME_IMPORT_PARSE_QUEUE,
  type ResumeImportParseJobData,
} from "../../queue/queue.constants";
import { Logger } from "@nestjs/common";
import {
  RESUME_SUMMARY_SURVIVING_FAILURES,
  ResumeParseService,
  type ParsedDraft,
} from "./resume-parse.service";
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
 * same document for one Hinglish line ({role} + {tajurba} + {summary}), staged on the row for
 * the "Kya ye aap hi hain?" turn. Best-effort by construction — a throw here must never cost
 * the worker their route or their failure record — so it is wrapped, logged PII-free, and
 * ignored.
 *
 * AND IT NOW RUNS ON TWO KINDS OF FAILURE TOO (ruling D9 amendment, owner, 2026-09-22, #1654).
 * `RESUME_SUMMARY_SURVIVING_FAILURES` is the closed set: `parse_output_invalid` and
 * `parse_deadline_exceeded`, the two reasons where the document was read fine and only OUR
 * model reply was unusable. Every other reason stays silent, and a second mechanism already
 * guarantees that — the summary runs its own `extract()`, so a document-level failure degrades
 * inside it and stages nothing. The set is not what makes them silent; it is what stops us
 * paying a storage fetch and a model call to rediscover it.
 *
 * WHICH IS WHY THE FAILURE SETTLE MOVED BELOW THE SUMMARY. `markFailed` makes the row
 * TERMINAL, and the worker-app's poll returns on the first terminal read, then navigates into
 * the chat, whose first turn asks for the staged line. Settling first therefore raced the
 * bubble off the screen — the line landed seconds after the question that needed it. On the
 * parsed path the summary has always staged while the row was still `parsing`; `settleFailure`
 * is what gives the failed path the same order. The client-side half of this ruling is #1661
 * and must ship alongside.
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
 * than a second charge. The deferred failure settle widens that window by one summary call and
 * not by one behaviour: a process that dies between the parse and `settleFailure` leaves the
 * same `parsing` row the parsed path would have left, redelivered the same way.
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

    // RI-summary, best-effort and never blocking: the Hinglish line is staged on the row
    // for the chat turn, and a failure here costs nothing — the route below still settles,
    // and the failure below is still recorded.
    //
    // BEFORE EITHER SETTLE, ALWAYS. The row is `parsing` at this point on both paths, which
    // is what `saveIdentitySummary`'s `status IN ('parsing','parsed')` guard already allows
    // and what keeps the polling client from reaching the chat before the line exists.
    if (needsIdentitySummary(draft)) {
      try {
        await this.summary.summarizeAndStage(workerId, draft.importId, ctx);
      } catch (error) {
        // PII-FREE: an error message, never document text. The summary is observability,
        // not the route — failing closed here means continuing, not stopping. The settle
        // below is deliberately OUTSIDE this catch: a worker must never lose his failure
        // record to a summary that threw.
        this.logger.warn(
          `résumé summary skipped for import ${importId}: ${(error as Error).message}`,
        );
      }
    }

    // THE DEFERRED FAILURE SETTLE — `markFailed` + `profile.resume_parse_failed` in the one
    // transaction the parse service would otherwise have run itself, guarded on `parsing` and
    // keyed the same way, so this is still exactly one event per import and a redelivery
    // (which returns `already_settled` without a draft) reaches none of it.
    if (draft.status === "failed" && !draft.settled) {
      await this.parse.settleFailure(workerId, draft, ctx);
    }

    const routed = await this.routing.route(workerId, draft, ctx);

    // IDS AND A CLOSED-SET ROUTE. This value is BullMQ's job result and is kept in Redis; it
    // must carry no more than the event already does. `null` when THIS delivery settled no
    // route — a failed parse, or a redelivery that found the row already past `parsing` — so
    // the job result never claims a route the row does not show.
    return { import_id: importId, route: routed?.route ?? null };
  }
}

/**
 * Is the "Kya ye aap hi hain?" line worth computing for this draft?
 *
 * A PARSE, OR ONE OF OUR OWN TWO FAILURES — never a document-level one, and never a
 * redelivery's `already_settled` (which carries no import id and whose row already holds
 * whatever line the first delivery staged).
 *
 * THE CLOSED SET IS DELIBERATE AND MUST NOT BE COLLAPSED into `draft.status === "failed"`.
 * Doing so would still be CORRECT — the summary's own `extract()` degrades on a document with
 * no text layer, an encrypted one, an empty one, an unsupported one, one below the OCR floor,
 * and on an ai-service that is simply down — but it would pay a storage fetch and a model call
 * on every one of them to arrive at the same "stage nothing". The set is the reason we do not.
 */
function needsIdentitySummary(
  draft: ParsedDraft,
): draft is Extract<ParsedDraft, { status: "parsed" | "failed" }> {
  if (draft.status === "parsed") return true;
  return draft.status === "failed" && RESUME_SUMMARY_SURVIVING_FAILURES.has(draft.reason);
}
