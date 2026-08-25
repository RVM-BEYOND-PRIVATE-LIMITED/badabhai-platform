import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { PayloadInputOf } from "@badabhai/event-schema";
import { WORKER_FEEDBACK_ATTACHMENT_PREFIX, type WorkerAppScreenTemplate } from "@badabhai/types";
import type { RequestContext } from "../common/request-context";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { StorageService } from "../storage/storage.service";
import { WorkersRepository } from "../workers/workers.repository";
import { FeedbackRepository } from "./feedback.repository";
import type { SubmitFeedbackDto } from "./feedback.dto";

/** What the caller gets back: the row id, and deliberately nothing the worker typed. */
export interface SubmitFeedbackResult {
  id: string;
}

/**
 * One minted attachment slot (#1191). SNAKE_CASE ON PURPOSE — this interface IS the wire body,
 * byte-identical to the photo route's ticket ({ storage_path, upload_url, expires_in }), because
 * the Flutter client is ALREADY RELEASED against that exact shape and parses both routes with
 * the same code.
 *
 * `upload_url` IS A BEARER CREDENTIAL. It carries a token authorizing a write into a private
 * bucket, so it is never logged and never evented, and the route returning it sets
 * `Cache-Control: no-store`. `storage_path` is the server's own key, and is the only half the
 * client hands back on submit.
 */
export interface FeedbackAttachmentTicket {
  storage_path: string;
  upload_url: string;
  expires_in: number;
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
 * Both arrive ALREADY sanitized (`sanitizeAppBuild` / `resolveScreenTemplate`), so each is a
 * well-formed value or `null`, and neither is ever a reason for this call to fail.
 */
export interface SubmitFeedbackClientContext {
  /** `x-app-build` (#966): a commit SHA / build number, or null when absent or malformed. */
  readonly appBuild: string | null;
  /**
   * WHICH SCREEN of the worker app the feedback was about, or null.
   *
   * TYPED AS THE UNION, NOT AS `string`, and that is the point rather than pedantry: the closed
   * set `resolveScreenTemplate` guarantees is then carried by the compiler all the way to the
   * event payload, so a caller that reached for a raw path — the exact §2 failure this field has
   * had twice — does not compile.
   */
  readonly screenContext: WorkerAppScreenTemplate | null;
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
    private readonly storage: StorageService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /**
   * Mint ONE signed upload slot for a feedback image (#1191) — the ADR-0032 photo seam applied
   * to a second kind of object.
   *
   * THE SERVER CHOOSES THE KEY AND THE CLIENT CHOOSES NOTHING. The request body is empty and the
   * destination is `feedback-attachments/<workerId>/<uuid>.jpg`, with the worker id taken from
   * the bearer token. That is what makes the submit-time ownership check a PROOF rather than a
   * convention: there is no shape a caller can ask for, so a path that does not match the minted
   * shape for the session worker was not minted for them.
   *
   * ONE SLOT PER CALL, and the client calls it once per image. Returning three keys in one
   * response would save two round trips and cost the property above nothing — but a worker who
   * attaches one image would then mint three slots, and an unused slot is exactly the orphan the
   * per-IP cap on the route exists to bound.
   *
   * NO EVENT. Minting is an authorization grant, not a state change — the ruling the photo route
   * already makes. The submission that follows carries `attachment_count`; a slot nobody used is
   * not a business fact.
   *
   * DORMANT UNTIL THE BUCKET IS SET, and that is safe HERE in a way it would not be on the
   * submit route: an unset `WORKER_FEEDBACK_ATTACHMENTS_BUCKET` is a 503, and the shipped client
   * degrades honestly on it — the image is dropped and the worker's typed message still submits.
   */
  async createAttachmentUploadUrl(workerId: string): Promise<FeedbackAttachmentTicket> {
    const bucket = this.config.WORKER_FEEDBACK_ATTACHMENTS_BUCKET;
    if (!bucket) {
      throw new ServiceUnavailableException("feedback attachments not enabled");
    }
    // The same existence guard {@link submit} makes, for the same reason: a session outliving
    // its worker (an account deleted mid-session) should be an honest 404 rather than a signed
    // WRITE url into a prefix no erasure sweep will ever visit again.
    const worker = await this.workers.findById(workerId);
    if (!worker) throw new NotFoundException(`Worker ${workerId} not found`);

    const objectKey = `${WORKER_FEEDBACK_ATTACHMENT_PREFIX}/${workerId}/${randomUUID()}.jpg`;
    const { url, expiresIn } = await this.storage.createSignedUploadUrl(objectKey, bucket);
    // NOT LOGGED, HERE OR ANYWHERE. The url is a write capability into a private bucket with a
    // two-hour life; the key is the diagnosable half and it is already in the response.
    return { storage_path: objectKey, upload_url: url, expires_in: expiresIn };
  }

  /**
   * The paths this worker may claim — all of them, or none.
   *
   * THE IDOR CONTROL FOR #1191, AND THE ONLY ONE. `workerId` is session-derived and the DTO is
   * `.strict()`, so no body can supply one; what a body CAN supply is somebody else's object
   * key, which every shape rule in the DTO happily accepts. This is where that is refused — the
   * identical minted-key check `WorkersService.confirmPhoto` makes — and it is a check on
   * OWNERSHIP rather than on format: the pattern is rebuilt per request around the caller's own
   * id, so a path can only match if this server minted it for this worker.
   *
   * ALL-OR-NOTHING, AND BEFORE THE WRITE. One bad path rejects the WHOLE submission with a 400
   * rather than dropping that path and storing the rest. Dropping would be worse in both
   * directions: an honest client with a bug would believe its images landed and never be told
   * (the #694 precedent), and a hostile one would learn which of its guesses were accepted, one
   * request at a time.
   *
   * NOTHING TOUCHES STORAGE HERE. A `getObjectInfo` per path — object exists, is a JPEG, is
   * within the size cap — is what `confirmPhoto` does, and it is deliberately NOT done here:
   * this runs in the request that opens the write transaction, so a storage blip would roll back
   * the worker's typed message over an image. The mime and size ceilings live on the BUCKET
   * (`allowed_mime_types`, `file_size_limit`), where Supabase refuses the PUT itself and no
   * transaction of ours is at stake.
   */
  private validateAttachmentPaths(workerId: string, paths: readonly string[]): string[] {
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- the only interpolated value is `workerId`, which is session-derived and a UUID (hex + dashes), so it carries no regex metacharacter and cannot widen the pattern. The submitted paths are the strings being TESTED, never part of the pattern.
    const mintedKeyShape = new RegExp(
      `^${WORKER_FEEDBACK_ATTACHMENT_PREFIX}/${workerId}/` +
        "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.jpg$",
    );
    for (const path of paths) {
      if (!mintedKeyShape.test(path)) {
        // ⚠ THE REJECTED PATH IS NOT ECHOED BACK. It is the one caller-controlled string in this
        // request, so naming it in the message would put it in the response body and — via
        // `AllExceptionsFilter` on any later 5xx — in a log. The shape it had to match is a
        // server-side constant, so saying THAT costs nothing and tells an honest client
        // everything it needs.
        throw new BadRequestException("attachment_paths must be upload slots minted for you");
      }
    }
    return [...paths];
  }

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

    // ── OWNERSHIP, BEFORE ANYTHING IS WRITTEN (#1191) ──────────────────────────────────────
    // Absent stays NULL rather than becoming `[]`: the shipped client omits the key when the
    // worker attached nothing, every reader treats the two identically, and a second spelling of
    // one fact is how a column starts needing a comment to read.
    //
    // The 400 this can throw is raised HERE, ABOVE `withTransaction`, deliberately. Refusing
    // before the transaction opens is what makes the rejection all-or-nothing in the strong
    // sense: no row is written, no event is emitted, and there is no rollback to perform.
    const attachmentPaths =
      dto.attachment_paths === undefined
        ? null
        : this.validateAttachmentPaths(workerId, dto.attachment_paths);
    const attachmentCount = attachmentPaths?.length ?? 0;

    const { appBuild, screenContext } = client;

    const row = await this.repo.withTransaction(async (tx) => {
      const inserted = await this.repo.insert(
        { workerId, category, message: dto.message, appBuild, screenContext, attachmentPaths },
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
          // WHICH SCREEN, and it may ride the spine precisely because it cannot be anything
          // else: `resolveScreenTemplate` returns one of the app's own 28 route constants or
          // null, so there is nothing here that links this row to a specific job, session or
          // worker — and nothing here that a caller composed. "Which screen generated this
          // complaint" is exactly the kind of shape question the audit record exists to answer,
          // alongside the category and the length.
          screen_context: screenContext,
          // HOW MANY IMAGES, NEVER THE KEYS — the ruling `message_length` makes about the text,
          // applied to the other thing the row now holds. An object key is a DURABLE pointer at
          // a private image, so a key here would be a handle on the audit trail that outlives
          // every signed url minted for it and routes around the admin surface that audits the
          // read. A count dereferences nothing, and still answers the two questions this
          // widening exists for: did the attach flow reach production, and are problem reports
          // arriving with evidence.
          attachment_count: attachmentCount,
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
        // The SCREEN NAME is loggable for the same reason it is eventable — it is one of our own
        // constants, so no caller-chosen byte can be interpolated here. A raw path would not be:
        // it would put an entity id in the log a `message` is deliberately kept out of.
        `screen=${screenContext ?? "unknown"} attachments=${attachmentCount}`,
    );
    return { id: row.id };
  }
}
