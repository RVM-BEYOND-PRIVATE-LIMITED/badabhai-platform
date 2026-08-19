import { Injectable } from "@nestjs/common";
import { AdminFeedbackRepository } from "./admin-feedback.repository";
import { decodeEntityCursor, encodeEntityCursor } from "./admin-entities.cursor";
import type { AdminPage } from "./admin-entities.dto";
import type { AdminFeedbackListItem, AdminFeedbackQueryDto } from "./admin-feedback.dto";

/**
 * The admin worker-feedback read service (#997).
 *
 * Thin by design, exactly like its BP-1 sibling: validation happens at the Zod pipe, the
 * projection happens in the repository's select list, and authorization happens in the guards.
 * What is left — and the only thing this layer owns — is keyset paging.
 *
 * NO EVENTS. A read is not a state change, so it emits nothing (CLAUDE.md §1). The privileged
 * read that IS audited is the PII reveal, which lives in its own service behind its own
 * capability and its own default-off flag; that asymmetry is the point, and it is why this
 * screen showing a worker's own words is not the same act as revealing who they are.
 */
/**
 * Canonical 8-4-4-4-12 hex form — what a `uuid` column accepts and what `encodeEntityCursor`
 * emits. A cursor id that is not one cannot match a row, so falling back to the first page
 * loses nothing a correct cursor would have found.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AdminFeedbackService {
  constructor(private readonly repo: AdminFeedbackRepository) {}

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
  async list(dto: AdminFeedbackQueryDto): Promise<AdminPage<AdminFeedbackListItem>> {
    const cursor = decodeEntityCursor(dto.cursor);
    const rows = await this.repo.list(
      { category: dto.category },
      cursor && UUID_RE.test(cursor.id) ? cursor : null,
      dto.limit + 1,
    );
    return AdminFeedbackService.page(rows, dto.limit);
  }
}
