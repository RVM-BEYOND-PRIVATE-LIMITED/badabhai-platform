import { Injectable } from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { AdminFeedbackRepository } from "./admin-feedback.repository";
import { decodeEntityCursor, encodeEntityCursor } from "./admin-entities.cursor";
import type { AdminPage } from "./admin-entities.dto";
import type { AdminFeedbackListItem, AdminFeedbackQueryDto } from "./admin-feedback.dto";

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
/**
 * Canonical 8-4-4-4-12 hex form — what a `uuid` column accepts and what `encodeEntityCursor`
 * emits. A cursor id that is not one cannot match a row, so falling back to the first page
 * loses nothing a correct cursor would have found.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AdminFeedbackService {
  constructor(
    private readonly repo: AdminFeedbackRepository,
    private readonly events: EventsService,
  ) {}

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
  private static page(
    rows: AdminFeedbackListItem[],
    limit: number,
  ): AdminPage<AdminFeedbackListItem> {
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
   * `decodeEntityCursor` alone does NOT make that true. It validates the timestamp half and
   * accepts the id half as any string, so `{"c":<valid>,"i":"x"}` decodes cleanly and then
   * binds `x` against a `uuid` column — Postgres rejects it at BIND with 22P02 and the filter
   * turns it into a 500, which is precisely what the paragraph above promises does not happen.
   * The guard is here rather than in the shared decoder because that decoder is on the BP-1
   * entity and finance reads too, and widening it is their change to make, not this one's
   * (raised separately).
   */
  async list(
    adminId: string,
    dto: AdminFeedbackQueryDto,
    ctx: RequestContext,
  ): Promise<AdminPage<AdminFeedbackListItem>> {
    const cursor = decodeEntityCursor(dto.cursor);
    const rows = await this.repo.list(
      { category: dto.category, workerId: dto.workerId },
      cursor && UUID_RE.test(cursor.id) ? cursor : null,
      dto.limit + 1,
    );
    const page = AdminFeedbackService.page(rows, dto.limit);

    // AUDIT BEFORE THE WORDS LEAVE THE PROCESS, awaited and fail-closed — see the class header
    // for why this one emits after the fetch rather than before it. `page.items.length`, not
    // `rows.length`: the repository over-fetches by one to detect a next page, and auditing the
    // peeked row would claim the admin saw one message more than they did on every full page.
    await this.auditFeedbackRead(adminId, dto, page.items.length, ctx);

    return page;
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
