import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { StorageService } from "../storage/storage.service";
import { AdminFeedbackRepository } from "./admin-feedback.repository";
import { decodeEntityCursor, encodeEntityCursor } from "./admin-entities.cursor";
import type { AdminPage } from "./admin-entities.dto";
import type {
  AdminFeedbackListItem,
  AdminFeedbackQueryDto,
  AdminFeedbackRow,
} from "./admin-feedback.dto";

/**
 * The admin worker-feedback read service (#997).
 *
 * Thin by design, exactly like its BP-1 sibling: validation happens at the Zod pipe, the
 * projection happens in the repository's select list, and authorization happens in the guards.
 * What is left is keyset paging, and the audit of the read.
 *
 * ── ONE EVENT, AND IT IS AN AUDIT OF A READ (ADR-0025 Amendment 1) ───────────────────────
 * The other admin READ services emit nothing, because a read is not a state change. This one
 * emits `admin.feedback_viewed`, and the asymmetry is the same one `AdminWorkerJourneyService`
 * makes: those reads return an entity snapshot; this one returns WORKER-AUTHORED FREE TEXT —
 * the single sanctioned exception on this whole surface, prose a worker may well have put their
 * own name or phone number into. Reading a worker's step counts already left a trail; reading
 * their actual words left none, which made `FeedbackService`'s own claim that the message is
 * "one authenticated admin screen away, behind an audited surface" untrue. This closes that.
 *
 * The route sits on `read_entities`, the floor all four roles hold. Access being broad is
 * exactly why the trail has to exist — the argument the journey read already settled.
 *
 * THREE PROPERTIES OF THE EMISSION, each a decision:
 *
 *  - AFTER THE ROWS ARE FETCHED, BEFORE THEY ARE RETURNED. This is the ONE place the posture
 *    differs from `auditJourneyRead`, which emits before its read — and the reason is the
 *    payload: `result_count` is part of the audit fact ("how much of this worker's prose did
 *    this admin actually see") and does not exist until the query has run. The property that
 *    matters is preserved exactly, because the emit is awaited: no message text reaches the
 *    caller unless the audit row committed first. Rows sitting in this process's memory are not
 *    a disclosure; rows in the response are.
 *  - AWAITED AND FAIL-CLOSED. An emit failure propagates and the caller gets an error instead
 *    of the page — the discipline `AdminPiiRevealService` applies to its audit-before-decrypt
 *    and `AdminWorkerJourneyService` to its journey read. A trail that is best-effort is not a
 *    control; it is a log line. The cost is one `events` insert per page view on a low-volume
 *    internal surface.
 *  - PII-FREE. An opaque admin id, the two filters as applied, and a count. NEVER the message
 *    text, an excerpt, or a length — the payload's `.strict()` is the structural backstop, and
 *    its own header explains why even a length is refused here.
 */

@Injectable()
export class AdminFeedbackService {
  /** Only ever used for the best-effort signing WARN below. Named for the class, like every
   *  other logger in this API, so the line is greppable by the surface that emitted it. */
  private readonly logger = new Logger(AdminFeedbackService.name);

  constructor(
    private readonly repo: AdminFeedbackRepository,
    private readonly events: EventsService,
    private readonly storage: StorageService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /**
   * Turn each row's STORED KEYS into short-lived signed urls (#1191) — best-effort, per row.
   *
   * ── FAIL OPEN, AND THIS IS THE ONE PLACE ON THIS SURFACE THAT DOES ────────────────────────
   * Everything else here fails closed: the audit emit is awaited and propagates, a bad cursor
   * is refused rather than guessed at. This is the deliberate exception, because of what the
   * screen is FOR. The message is the feature — the words a worker typed to reach us — and the
   * images are corroboration. Letting a Storage blip, an unprovisioned bucket, or one row's
   * missing object turn the whole page into an error would trade the thing that matters for the
   * thing that supports it. So a row that cannot be signed reports `attachment_urls: []`, which
   * is the same shape a row with no images has, and the operator still reads the complaint.
   *
   * PER ROW, NOT PER PATH, and that is the granularity the issue specifies. Within one row the
   * mints are sequential and the first failure abandons the rest: a partial list would show two
   * of three images with nothing saying the third existed, which is a quieter lie than an empty
   * cell next to a message that says "photo attached".
   *
   * DORMANT BUCKET IS NOT AN ERROR. While `WORKER_FEEDBACK_ATTACHMENTS_BUCKET` is unset no
   * worker could have uploaded anything, so there is nothing to sign and nothing to warn about
   * — the check is first so the dormant deployment does not log once per row forever.
   *
   * VOLUME. Rows are signed concurrently and paths within a row are not, so the fan-out is
   * bounded by the rows on ONE page that actually carry images (`ADMIN_FEEDBACK_PAGE_MAX` = 100
   * in the worst case, and in practice a small fraction of a page, since most feedback is text).
   * If that ever stops being true, Supabase's batch sign endpoint takes a whole page in one
   * request; it is not used today because `createSignedUrl` is the call path already proven in
   * production by the resume download, and a fail-open feature should not be the first caller of
   * an untested endpoint.
   */
  private async withSignedAttachments(rows: AdminFeedbackRow[]): Promise<AdminFeedbackListItem[]> {
    const bucket = this.config.WORKER_FEEDBACK_ATTACHMENTS_BUCKET;
    const ttl = this.config.RESUME_SIGNED_URL_TTL_SECONDS;

    return Promise.all(
      rows.map(async ({ attachment_paths, ...row }): Promise<AdminFeedbackListItem> => {
        if (!bucket || attachment_paths.length === 0) return { ...row, attachment_urls: [] };
        try {
          const attachment_urls: string[] = [];
          for (const path of attachment_paths) {
            // `Content-Disposition: attachment` on the signed url (defence in depth): these
            // are WORKER-SUPPLIED bytes, so a top-level click must never render them on the
            // storage origin. The filename is the key's own basename — a uuid this server
            // minted — so no caller-chosen byte reaches it. Thumbnails are unaffected:
            // browsers ignore the header for `<img src>`.
            attachment_urls.push(
              await this.storage.createSignedUrl(
                path,
                ttl,
                bucket,
                path.slice(path.lastIndexOf("/") + 1),
              ),
            );
          }
          return { ...row, attachment_urls };
        } catch (err) {
          // NEITHER THE PATH NOR THE URL IS LOGGED. A path is a durable handle to a worker's
          // private image and a url is a live one; the row id is the diagnosable half, and the
          // bucket name (config, never PII) is what an operator actually needs — StorageService
          // has already named it and the status in its own error line.
          this.logger.warn(
            `feedback attachment signing failed for row ${row.id}; the row is served with no ` +
              `images (message unaffected): ${err instanceof Error ? err.message : String(err)}`,
          );
          return { ...row, attachment_urls: [] };
        }
      }),
    );
  }

  /**
   * Turn `limit + 1` fetched rows into a page plus an HONEST `nextCursor`.
   *
   * Over-fetching by one is what makes it honest. Deriving the cursor from "we returned
   * exactly `limit` rows" produces a phantom next page whenever the total is an exact multiple
   * of the page size — the operator clicks Next and lands on an empty screen, which reads as
   * data loss rather than as the end of the list.
   *
   * Duplicated from {@link import("./admin-entities.service").AdminEntitiesService} rather
   * than hoisted into a shared helper: the two return DIFFERENT envelopes (`AdminPage` here,
   * `AdminFinancePage` there) over different row types, and BP-2 already made the same call.
   * Extracting it would mean a generic over the envelope for eight lines of slicing.
   */
  private static page(rows: AdminFeedbackRow[], limit: number): AdminPage<AdminFeedbackRow> {
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        hasMore && last
          ? encodeEntityCursor({ createdAt: last.created_at.toISOString(), id: last.id })
          : null,
    };
  }

  /**
   * One page of feedback, newest first, optionally narrowed to a category.
   *
   * A malformed/tampered/truncated cursor decodes to `null` and is served as the FIRST page
   * rather than a 500 — a cursor is client-held state and will arrive hand-edited or clipped
   * by a link shortener sooner or later, and an operator seeing a stack trace instead of the
   * top of the list learns nothing useful.
   *
   * `decodeEntityCursor` is what makes that true, for BOTH halves. It used to validate only
   * the timestamp and accept the id as any string, so `{"c":<valid>,"i":"x"}` decoded cleanly
   * and then bound `x` against a `uuid` column — a 22P02 at BIND, surfaced as a 500. This
   * service carried a local uuid guard for exactly that reason; #1014 moved the check into the
   * shared decoder, where the BP-1 entity and finance reads needed it too, and the local one
   * was deleted rather than left as a second answer to the same question.
   */
  async list(
    adminId: string,
    dto: AdminFeedbackQueryDto,
    ctx: RequestContext,
  ): Promise<AdminPage<AdminFeedbackListItem>> {
    const cursor = decodeEntityCursor(dto.cursor);
    const rows = await this.repo.list(
      { category: dto.category, workerId: dto.workerId },
      cursor,
      dto.limit + 1,
    );
    const page = AdminFeedbackService.page(rows, dto.limit);

    // AUDIT BEFORE THE WORDS LEAVE THE PROCESS, awaited and fail-closed — see the class header
    // for why this one emits after the fetch rather than before it. `page.items.length`, not
    // `rows.length`: the repository over-fetches by one to detect a next page, and auditing the
    // peeked row would claim the admin saw one message more than they did on every full page.
    await this.auditFeedbackRead(adminId, dto, page.items.length, ctx);

    // SIGNING HAPPENS AFTER THE SLICE, so the over-fetched row nobody will see never costs a
    // Storage round trip — and AFTER THE AUDIT, so a page of images cannot be minted for a read
    // whose trail failed to commit. Neither ordering is cosmetic: the audit is the compensating
    // control that makes this surface acceptable, and a signed url is the most durable thing it
    // hands out.
    return { items: await this.withSignedAttachments(page.items), nextCursor: page.nextCursor };
  }

  /**
   * Record that `adminId` read a page of worker feedback. AWAITED; a failure PROPAGATES.
   *
   * The ACTOR is the session admin the guard resolved — never a caller-supplied id. The SUBJECT
   * is that admin's session rather than a worker, because this route's worker narrowing is an
   * optional FILTER and not a path parameter; filing the filtered reads under a worker subject
   * would make the worker-axis spine query look complete while silently omitting every
   * unfiltered page that contained the same worker's message. The payload schema's header
   * carries the full argument and the `admin.pii_reveal_cap_exceeded` precedent.
   */
  private async auditFeedbackRead(
    adminId: string,
    dto: AdminFeedbackQueryDto,
    resultCount: number,
    ctx: RequestContext,
  ): Promise<void> {
    await this.events.emit({
      event_name: "admin.feedback_viewed",
      actor: { actor_type: "admin", actor_id: adminId },
      subject: { subject_type: "admin_session", subject_id: adminId },
      payload: {
        admin_id: adminId,
        // `?? null` rather than passing `undefined` through: "no filter" is a fact the audit
        // records explicitly, and the payload's `.default(null)` would otherwise make an
        // omitted filter and an absent field indistinguishable to a reader of old rows.
        worker_id: dto.workerId ?? null,
        category: dto.category ?? null,
        result_count: resultCount,
      } satisfies PayloadInputOf<"admin.feedback_viewed">,
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }
}
