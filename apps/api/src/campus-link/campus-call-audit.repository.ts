import { Inject, Injectable } from "@nestjs/common";
import { auditLogs, type Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** The `audit_logs.action` of every Campus call. One value, so a reader can filter on it. */
export const CAMPUS_CALL_AUDIT_ACTION = "campus_link.call";

/** What became of a call that reached the token check. */
export type CampusCallOutcome = "accepted" | "refused_token" | "rate_limited";

export interface CampusCallAudit {
  /** This row's id, also returned to Campus in `x-campus-call-id`. */
  callId: string;
  outcome: CampusCallOutcome;
  method: string;
  /**
   * The route template (`/internal/campus/v1/students/:student_ref`), never the concrete path, so
   * no reference a later unlink or erasure must remove is kept here.
   */
  path: string;
  /** `Controller.handler` that the call was routed to. */
  handler: string;
  /** Which configured token matched (0 or 1 during a rotation); null when none did. */
  tokenSlot: number | null;
}

/**
 * One `audit_logs` row per Campus call (plan 4.2), written by `CampusServiceGuard` before the
 * handler runs. `audit_logs` rather than a new table: it is the codebase's "who did what" store,
 * needs no migration, and `entity_id` takes the call id, so a call Campus quotes back to us is one
 * indexed lookup. The rows a write route makes itself (its own row and event) are separate and
 * land in that route's transaction.
 *
 * WRITE-ONLY. No body, no token and no address is ever stored here.
 */
@Injectable()
export class CampusCallAuditRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async record(audit: CampusCallAudit): Promise<void> {
    await this.db.insert(auditLogs).values({
      actorType: "campus_service",
      actorId: null,
      action: CAMPUS_CALL_AUDIT_ACTION,
      entityType: "campus_link_call",
      entityId: audit.callId,
      metadata: {
        outcome: audit.outcome,
        method: audit.method,
        path: audit.path,
        handler: audit.handler,
        token_slot: audit.tokenSlot,
      },
    });
  }
}
