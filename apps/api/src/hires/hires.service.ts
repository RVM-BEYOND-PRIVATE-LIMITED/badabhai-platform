import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Database } from "@badabhai/db";
import type { PayloadInputOf } from "@badabhai/event-schema";
import type { HireRecordSource, HireStatus } from "@badabhai/types";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { decodeEntityCursor, encodeEntityCursor } from "../admin/admin-entities.cursor";
import { hireRecordsEnabled, type HireRecordsConfig } from "./hires.flag";
import { nextHireState, type HireState } from "./hire-state";
import { HiresRepository, type AdminHireRow, type HireKey } from "./hires.repository";
import type { AdminHireListItem, AdminHiresPage, AdminHiresQueryDto } from "./admin-hires.dto";

/**
 * Who said it, for the event envelope: the company login that moved the board or answered, the
 * worker, or the admin at the desk. Never the tenant key (that is the record's own key).
 */
export interface HireOrigin {
  readonly actor: {
    readonly actor_type: "payer" | "worker" | "admin";
    readonly actor_id: string;
  };
  readonly correlationId: string;
  readonly requestId?: string;
}

/** What one source call did. */
export interface HireWrite {
  /** The record was created or changed, and `hire.recorded` was emitted on the caller's tx. */
  readonly changed: boolean;
  /** The record after the call; `null` when there is none (a take-back of nothing, or off). */
  readonly hire: { readonly id: string; readonly status: HireStatus } | null;
}

const NOTHING: HireWrite = { changed: false, hire: null };

/**
 * #2753 item 9 — HIRE RECORDS: one `hires` row per company, worker and posting.
 *
 * ONE METHOD PER SOURCE, EACH ON THE CALLER'S TRANSACTION, so a hire commits (or rolls back) with
 * the stage move, the answer or the desk action that said it:
 *  - {@link recordCompanyMark} / {@link undoCompanyMark}: the company's board (wired:
 *    `PayerApplicantStagesService`, a real move into or out of `hired`);
 *  - {@link recordCompanyAnswer}: the company's follow-up answer (item 10, one call to add);
 *  - {@link recordWorkerAnswer}: the worker's monthly-check answer (item 5, one call to add);
 *  - {@link confirmByDesk} / {@link reject}: the worker desk.
 * Each upserts the SAME row on the unique key, so three sources give ONE record (the issue's
 * check). The rules are {@link nextHireState}'s; this class locks, writes and emits.
 *
 * ONE EVENT PER REAL CHANGE: `hire.recorded` in the same transaction as the row, only when the
 * record was created, its status moved, or a source said "hired" for the first time. No idempotency
 * key, deliberately (the stage event's reasoning): an undo and a later re-mark are two real
 * changes, and exactly-once comes from the row lock and the no-op rule.
 *
 * OFF MEANS ABSENT. With `HIRE_RECORDS_ENABLED` off the callers do not call (they ask
 * {@link enabled} first), and should one call anyway every method answers "nothing" without naming
 * the table — so a caller's own transaction never fails on a missing migration.
 */
@Injectable()
export class HiresService {
  constructor(
    private readonly repo: HiresRepository,
    private readonly events: EventsService,
    @Inject(SERVER_CONFIG) private readonly config: HireRecordsConfig,
  ) {}

  /** `HIRE_RECORDS_ENABLED`, read through the one shared reader. */
  get enabled(): boolean {
    return hireRecordsEnabled(this.config);
  }

  /** The company moved the applicant INTO `hired` on its board: a confirmation. */
  recordCompanyMark(key: HireKey, at: Date, tx: Database, by: HireOrigin): Promise<HireWrite> {
    return this.record("company_mark", key, at, tx, by);
  }

  /**
   * The company moved him OUT of `hired`: THE UNDO. A record its mark alone confirmed goes to
   * `rejected` (the timestamps stay); one a company answer or the desk also confirmed is left
   * alone, and so is a record that does not exist.
   */
  undoCompanyMark(key: HireKey, at: Date, tx: Database, by: HireOrigin): Promise<HireWrite> {
    return this.record("company_unmark", key, at, tx, by);
  }

  /** The company's follow-up answer was "hired" (item 10): a confirmation. */
  recordCompanyAnswer(key: HireKey, at: Date, tx: Database, by: HireOrigin): Promise<HireWrite> {
    return this.record("company_answer", key, at, tx, by);
  }

  /**
   * The worker's own answer was "hired" (item 5). REPORTED, never confirmed by itself (owner
   * question 2 default); a record already confirmed stays confirmed.
   */
  recordWorkerAnswer(key: HireKey, at: Date, tx: Database, by: HireOrigin): Promise<HireWrite> {
    return this.record("worker_answer", key, at, tx, by);
  }

  /** The worker desk confirmed it: a confirmation. */
  confirmByDesk(key: HireKey, at: Date, tx: Database, by: HireOrigin): Promise<HireWrite> {
    return this.record("desk_confirm", key, at, tx, by);
  }

  /** The worker desk rejected it. A record that does not exist is left absent. */
  reject(key: HireKey, at: Date, tx: Database, by: HireOrigin): Promise<HireWrite> {
    return this.record("desk_reject", key, at, tx, by);
  }

  /**
   * `GET /admin/hires` — one keyset page, newest record first, optionally one status. Ids, the
   * status, the per-source timestamps and `hired_on`: no name, no phone (the admin applications
   * list's convention for a row that joins a worker to a posting).
   */
  async listForAdmin(query: AdminHiresQueryDto): Promise<AdminHiresPage> {
    // Defence in depth: the route's guard already refused, and no query may run while off.
    if (!this.enabled) throw new NotFoundException();
    const rows = await this.repo.listForAdmin(
      { status: query.status },
      decodeEntityCursor(query.cursor),
      query.limit + 1,
    );
    // Over-fetch by one, so the cursor is honest at an exact multiple of the page size.
    const hasMore = rows.length > query.limit;
    const items = (hasMore ? rows.slice(0, query.limit) : rows).map(toListItem);
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
   * Lock the record, ask the rules what it becomes, write that and emit — or do nothing. A first
   * write that loses the insert to a concurrent one (ours waited on it, so it is committed) locks
   * the winner's row and decides again from it.
   */
  private async record(
    source: HireRecordSource,
    key: HireKey,
    at: Date,
    tx: Database,
    by: HireOrigin,
  ): Promise<HireWrite> {
    if (!this.enabled) return NOTHING;

    let held = await this.repo.lockByKey(key, tx);
    if (held === null) {
      const created = nextHireState(null, source, at);
      if (created === null) return NOTHING;
      const id = await this.repo.insert(key, created, at, tx);
      if (id !== null) {
        await this.emit(id, key, created.status, source, tx, by);
        return { changed: true, hire: { id, status: created.status } };
      }
      held = await this.repo.lockByKey(key, tx);
      if (held === null)
        throw new Error("hires: a concurrent insert won the key but no row is there");
    }

    const { id, ...current } = held;
    const next: HireState | null = nextHireState(current, source, at);
    if (next === null) return { changed: false, hire: { id, status: current.status } };
    await this.repo.update(id, next, at, tx);
    await this.emit(id, key, next.status, source, tx, by);
    return { changed: true, hire: { id, status: next.status } };
  }

  /** `hire.recorded` on the caller's transaction. Ids and closed values only. */
  private async emit(
    hireId: string,
    key: HireKey,
    status: HireStatus,
    source: HireRecordSource,
    tx: Database,
    by: HireOrigin,
  ): Promise<void> {
    await this.events.emit({
      event_name: "hire.recorded",
      actor: by.actor,
      // The person the record is about; the posting and the record ride the payload.
      subject: { subject_type: "worker", subject_id: key.workerId },
      payload: {
        hire_id: hireId,
        worker_id: key.workerId,
        posting_kind: key.postingKind,
        posting_id: key.postingId,
        status,
        source,
      } satisfies PayloadInputOf<"hire.recorded">,
      correlationId: by.correlationId,
      requestId: by.requestId,
      tx,
    });
  }
}

function toListItem(r: AdminHireRow): AdminHireListItem {
  return {
    id: r.id,
    tenant_payer_id: r.tenantPayerId,
    worker_id: r.workerId,
    posting_kind: r.postingKind,
    posting_id: r.postingId,
    status: r.status,
    company_marked_at: r.companyMarkedAt,
    company_answered_at: r.companyAnsweredAt,
    worker_answered_at: r.workerAnsweredAt,
    desk_confirmed_at: r.deskConfirmedAt,
    hired_on: r.hiredOn,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}
