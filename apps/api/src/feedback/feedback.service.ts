import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";
import { FeedbackRepository } from "./feedback.repository";
import type { SubmitFeedbackDto } from "./feedback.dto";

/** What the caller gets back: the row id, and deliberately nothing the worker typed. */
export interface SubmitFeedbackResult {
  id: string;
}

/**
 * The two SANITIZED telemetry values the edge derived, carried as a named object rather than as
 * two positional `string | null` parameters.
 *
 * That is a correctness decision, not a style one: adjacent same-typed nullable parameters are
 * silently swappable, and swapping these two would put a route pattern in `app_build` and a
 * build stamp in `screen_context` — both would pass every CHECK, both would land on the event
 * spine, and nothing anywhere would fail. Named fields make the same mistake a compile error.
 *
 * Both arrive ALREADY sanitized (`sanitizeAppBuild` / `sanitizeScreenContext`), so each is a
 * well-formed value or `null`, and neither is ever a reason for this call to fail.
 */
export interface SubmitFeedbackClientContext {
  /** `x-app-build` (#966): a commit SHA / build number, or null when absent or malformed. */
  readonly appBuild: string | null;
  /** The ROUTE PATTERN the worker was on (`/jobs/:id/apply`), or null. Never a concrete path. */
  readonly screenContext: string | null;
}

/**
 * The worker's own app feedback (#997) — one write, one event, one transaction.
 *
 * THE MESSAGE IS THE POINT AND THE MESSAGE IS THE HAZARD. `dto.message` is unbounded worker free
 * text; the worker is explicitly invited to say anything, so their own name, phone number or
 * employer is a LIKELY rather than an unlucky occurrence. CLAUDE.md §2 puts raw PII out of bounds
 * for logs, events, audit records and analytics — the `worker_feedback` row is the one place it
 * may live. So this service moves the text from the DTO to the repository and touches it exactly
 * once more, to take its LENGTH. Nothing here interpolates it into a string.
 *
 * ATOMIC BY CONSTRUCTION. The row and the `feedback.submitted` event commit together, the
 * `AdminActionsService` (must-fix H3) pattern. This is NOT the `job.search_performed` best-effort
 * case: that event has no system-of-record row behind it, so swallowing a failure costs telemetry
 * only. Here, a feedback row with no audit record — or an audit record for a row that never
 * landed — are both states nobody can reconcile afterwards.
 */
@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);

  constructor(
    private readonly repo: FeedbackRepository,
    private readonly workers: WorkersRepository,
    private readonly events: EventsService,
  ) {}

  /**
   * Store one submission and emit its audit event.
   *
   * `workerId` comes from the bearer token, never from the body — the controller takes it from
   * `@CurrentWorker` and the DTO is `.strict()`, so there is no other way for one to arrive.
   * `client` has already been sanitized at the edge (see {@link SubmitFeedbackClientContext}):
   * both values are well-formed or `null`, and neither is ever a reason for this call to fail.
   */
  async submit(
    workerId: string,
    dto: SubmitFeedbackDto,
    client: SubmitFeedbackClientContext,
    ctx: RequestContext,
  ): Promise<SubmitFeedbackResult> {
    // The FK would refuse an unknown worker anyway, but as a driver error the worker would see
    // as a generic 500 after typing a paragraph. Checking first turns a deleted-mid-session
    // account into an honest 404, the same guard `ActionsService` puts in front of its writes.
    const worker = await this.workers.findById(workerId);
    if (!worker) throw new NotFoundException(`Worker ${workerId} not found`);

    // NOT TAGGED IS NOT "other". The client omits the key when the worker did not choose a tag,
    // and defaulting it here would turn silence into an answer and make the category histogram
    // ops reads a lie. `null` all the way down: the column, the payload and the admin screen.
    const category = dto.category ?? null;
    // The one place the text is touched after the DTO — for its size, which is all the audit
    // trail is allowed to know.
    const messageLength = dto.message.length;

    const { appBuild, screenContext } = client;

    const row = await this.repo.withTransaction(async (tx) => {
      const inserted = await this.repo.insert(
        { workerId, category, message: dto.message, appBuild, screenContext },
        tx,
      );
      await this.events.emit({
        event_name: "feedback.submitted",
        actor: { actor_type: "worker", actor_id: workerId },
        subject: { subject_type: "worker", subject_id: workerId },
        payload: {
          worker_id: workerId,
          feedback_id: inserted.id,
          category,
          // THE LENGTH, NEVER THE TEXT. The words stay in the row this event points at; see the
          // payload's own note in packages/event-schema for why not even a hash of them rides.
          message_length: messageLength,
          app_build: appBuild,
          // The ROUTE PATTERN, and it may ride the spine precisely because it is a pattern:
          // `sanitizeScreenContext` has already replaced every id-shaped segment with `:id`, so
          // there is nothing here that links this row to a specific job, session or worker.
          // "Which screen generated this complaint" is exactly the kind of shape question the
          // audit record exists to answer, alongside the category and the length.
          screen_context: screenContext,
        } satisfies PayloadInputOf<"feedback.submitted">,
        // The row id is the natural key: one row, one audit record. A client that retried a
        // request which had already committed cannot produce a second event.
        idempotencyKey: `feedback.submitted:${inserted.id}`,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
        // Same transaction as the insert — an emit failure rolls the row back rather than
        // leaving feedback nobody can prove arrived.
        tx,
      });
      return inserted;
    });

    // NEVER THE MESSAGE, AND THIS IS THE LINE WHERE IT WOULD BE TEMPTING. An operator debugging
    // "did the feedback land?" needs the row id, not the words — the words are one authenticated
    // admin screen away, behind an audited surface, which is precisely the control that logging
    // them here would route around. The worker id is truncated for the same reason every other
    // log line in this API truncates it: enough to correlate, not enough to be a directory.
    this.logger.log(
      `feedback recorded id=${row.id} worker=${workerId.slice(0, 8)}… ` +
        `category=${category ?? "none"} length=${messageLength} build=${appBuild ?? "unknown"} ` +
        // The route PATTERN is loggable for the same reason it is eventable — it carries no id.
        // A raw path would not be: it would put an entity id in the log a `message` is kept out of.
        `screen=${screenContext ?? "unknown"}`,
    );
    return { id: row.id };
  }
}
