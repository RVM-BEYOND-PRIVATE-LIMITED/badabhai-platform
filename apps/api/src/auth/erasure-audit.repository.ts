import { Inject, Injectable } from "@nestjs/common";
import { auditLogs, type Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

import type { ErasureAudit } from "./erasure-audit";

/** The `audit_logs.action` this repository writes. One value, so a reader can filter on it. */
export const ERASURE_AUDIT_ACTION = "worker.erasure_executed";

/**
 * The durable record that a DSAR erasure ran, and what each store reported (TD58, #712).
 *
 * WHY `audit_logs` AND NOT THE EVENT. `worker.account_deleted` is emitted beside this and is
 * deliberately NOT extended: adding a field to a shipped event payload mutates a frozen contract
 * (invariant #8), which this repository exists to avoid rather than to work around. `audit_logs`
 * is the table the codebase already declares for *"who did what (no raw PII; reference ids
 * only)"*, it has no foreign key to `workers`, and it needed no migration — which matters on a
 * path whose whole point is that the worker row is about to stop existing.
 *
 * WRITE-ONLY, AND ONE ACTION. No read method and no update: an erasure record that could be
 * amended after the fact is not evidence. A reader wanting these rows queries
 * `audit_logs WHERE action = ERASURE_AUDIT_ACTION`, which the existing
 * `audit_logs_entity_idx` on (entity_type, entity_id) serves for the per-worker lookup.
 *
 * NO PII, ENFORCED BY WHAT IT ACCEPTS. It takes an {@link ErasureAudit} — prefixes, counts and a
 * closed set of outcomes — and never a key, a path, a phone or a transcript. The worker id is
 * the entity this row is ABOUT and is already opaque.
 */
@Injectable()
export class ErasureAuditRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async record(workerId: string, audit: ErasureAudit): Promise<void> {
    await this.db.insert(auditLogs).values({
      // The erasure is worker-initiated (ADR-0026 D4) and runs post-grace on the sweep's
      // schedule; the worker is the actor either way, matching `worker.account_deleted`'s actor.
      actorType: "worker",
      actorId: workerId,
      action: ERASURE_AUDIT_ACTION,
      entityType: "worker",
      entityId: workerId,
      metadata: audit as unknown as Record<string, unknown>,
    });
  }
}
