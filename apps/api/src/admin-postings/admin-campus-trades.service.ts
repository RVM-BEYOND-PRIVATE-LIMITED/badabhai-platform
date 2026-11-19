import { Injectable } from "@nestjs/common";
import { auditLogs } from "@badabhai/db";
import type { PayloadInputOf } from "@badabhai/event-schema";
import { TRADE_FORM_KINDS_ALL } from "@badabhai/types";
import { ADMIN_ACTION_CODES } from "../admin/admin-action-codes";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { AdminCampusTradesRepository, type CampusTradeRow } from "./admin-campus-trades.repository";
import type {
  CampusTradesPutDto,
  CampusTradesPutResult,
  CampusTradesView,
} from "./admin-campus-trades.dto";

/**
 * The `audit_logs.entity_id` of THE Campus trade list (there is one list, and `entity_id` is a
 * NOT NULL uuid). Fixed, so every change to the list reads as one entity's history.
 */
export const CAMPUS_TRADE_LIST_ENTITY_ID = "00000000-0000-4000-8000-000000002957";

/**
 * #2957 — the trades RVM trains and certifies. Only a job in an active one may be sent to Campus by
 * an admin (#2956, `AdminPostingAudienceService`); a painter job, or any trade RVM has no students
 * for, can only show on BadaBhai.
 *
 * A replace is ONE transaction: lock every row, add the new keys (or re-add removed ones), stamp the
 * missing ones removed, write one `audit_logs` row (the reason, what was added and removed, the
 * list after) and emit `admin.action_performed` (`campus_trades_set`). A call that changes nothing
 * writes nothing. Postings already sent to Campus keep their audience when their trade is removed
 * (a list decides new writes, never stored state — R81); the admin audience list flags them.
 */
@Injectable()
export class AdminCampusTradesService {
  constructor(
    private readonly repo: AdminCampusTradesRepository,
    private readonly events: EventsService,
  ) {}

  async get(): Promise<CampusTradesView> {
    return view(await this.repo.all());
  }

  async replace(
    adminId: string,
    dto: CampusTradesPutDto,
    ctx: RequestContext,
  ): Promise<CampusTradesPutResult> {
    const wanted = new Set(dto.trade_keys);
    return this.repo.withTransaction(async (tx) => {
      const rows = await this.repo.all(tx, true);
      const active = new Set(rows.filter((r) => r.removedAt === null).map((r) => r.tradeKey));
      const added = [...wanted].filter((k) => !active.has(k)).sort();
      const removed = [...active].filter((k) => !wanted.has(k)).sort();
      if (added.length === 0 && removed.length === 0) {
        return { ...view(rows), added, removed };
      }
      for (const key of added) await this.repo.add(tx, key, adminId);
      for (const key of removed) await this.repo.remove(tx, key, adminId);

      const action = ADMIN_ACTION_CODES.campus_trades_set;
      await tx.insert(auditLogs).values({
        actorType: "admin",
        actorId: adminId,
        action,
        entityType: "campus_trades",
        entityId: CAMPUS_TRADE_LIST_ENTITY_ID,
        metadata: {
          reason_code: dto.reason_code,
          reason_text: dto.reason_text,
          added,
          removed,
          trades_after: [...wanted].sort(),
        },
      });
      const payload: PayloadInputOf<"admin.action_performed"> = {
        admin_id: adminId,
        action_code: action,
        target_type: "campus_trades",
        target_id: CAMPUS_TRADE_LIST_ENTITY_ID,
      };
      await this.events.emit({
        event_name: "admin.action_performed",
        actor: { actor_type: "admin", actor_id: adminId },
        subject: { subject_type: "admin_session", subject_id: adminId },
        payload,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
        idempotencyKey: `admin_action:${action}:${adminId}:${ctx.requestId}`,
        tx,
      });
      return { ...view(await this.repo.all(tx)), added, removed };
    });
  }
}

/** Every trade kind, with whether RVM trains it now (a removed row reads as not taught). */
function view(rows: readonly CampusTradeRow[]): CampusTradesView {
  const byKey = new Map(rows.map((r) => [r.tradeKey, r]));
  return {
    trades: TRADE_FORM_KINDS_ALL.map((key) => {
      const row = byKey.get(key);
      const taught = row !== undefined && row.removedAt === null;
      return {
        trade_key: key,
        taught_at_campus: taught,
        added_by_admin_id: taught ? row.addedByAdminId : null,
        added_at: taught ? row.addedAt.toISOString() : null,
        removed_at: row?.removedAt?.toISOString() ?? null,
      };
    }),
  };
}
