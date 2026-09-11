import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";

import {
  RESUME_IMPORT_PARSE_QUEUE,
  type ResumeImportParseJobData,
} from "../../queue/queue.constants";
import { ResumeParseService } from "./resume-parse.service";
import { ResumeRouteService } from "./resume-route.service";

/**
 * The BullMQ ADAPTER for a résumé import — read the document, then route the worker.
 *
 * TWO SERVICES, ONE JOB, AND THE ORDER IS THE CONTRACT. RI-3 reads and gates; RI-4 decides and
 * stages. Splitting them into two queue hops would buy nothing and cost the one thing that
 * matters here: a parse that succeeded while its routing failed would leave a `parsed` row
 * with no route, which is a state the worker's client cannot act on. One job means the
 * document is read at most once (`markParsing` is the lock) and the decision follows it.
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
  constructor(
    private readonly parse: ResumeParseService,
    private readonly routing: ResumeRouteService,
  ) {
    super();
  }

  async process(job: Job<ResumeImportParseJobData>): Promise<{ import_id: string; route: string }> {
    const { workerId, importId, correlationId, requestId } = job.data;
    const ctx = { correlationId, requestId };

    const draft = await this.parse.parse(workerId, importId, ctx);
    const routed = await this.routing.route(workerId, draft, ctx);

    // IDS AND A CLOSED-SET ROUTE. This value is BullMQ's job result and is kept in Redis; it
    // must carry no more than the event already does.
    return { import_id: importId, route: routed.route };
  }
}
