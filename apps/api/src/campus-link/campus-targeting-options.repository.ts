import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { auditLogs, rvmTargetingOptions, type Database, type RvmTargetingKind } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/** One stored targeting option, every column the replacement compares. */
export interface StoredTargetingOption {
  kind: RvmTargetingKind;
  ref: string;
  label: string;
  active: boolean;
  sortOrder: number;
}

/** One option to insert, or to update in place (label, order, back to active). */
export interface TargetingOptionWrite {
  kind: RvmTargetingKind;
  ref: string;
  label: string;
  sortOrder: number;
}

/** The refs of each kind to retire. */
export interface TargetingOptionRetirement {
  branch: readonly string[];
  course: readonly string[];
}

/** `audit_logs.action` of a targeting-options replacement. */
export const CAMPUS_TARGETING_AUDIT_ACTION = "campus_link.targeting_options_set";

/**
 * Serialises replacements. Two concurrent full-list PUTs would otherwise interleave their upserts
 * and retirements row by row and leave a list neither of them sent.
 */
const REPLACE_LOCK_KEY = "rvm_targeting_options:replace";

/**
 * #2746 PR 5 — the branches and courses a company may target (`rvm_targeting_options`), as Campus
 * replaces them (`PUT targeting-options`). DATABASE ACCESS ONLY: what is added, updated or retired
 * is `CampusTargetingOptionsService`'s decision. NOTHING HERE DELETES: postings hold the refs, so
 * an option that leaves Campus's list is only marked inactive.
 */
@Injectable()
export class CampusTargetingOptionsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  withTransaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    return this.db.transaction(work as (tx: unknown) => Promise<T>);
  }

  /** A transaction-scoped advisory lock: one replacement at a time, released at commit. */
  async lockForReplace(tx: Database): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${REPLACE_LOCK_KEY}, 0))`);
  }

  /** Every option, active or not. Read after {@link lockForReplace}. */
  async listAll(tx: Database): Promise<StoredTargetingOption[]> {
    return tx
      .select({
        kind: rvmTargetingOptions.kind,
        ref: rvmTargetingOptions.ref,
        label: rvmTargetingOptions.label,
        active: rvmTargetingOptions.active,
        sortOrder: rvmTargetingOptions.sortOrder,
      })
      .from(rvmTargetingOptions);
  }

  /** Insert new options and rewrite known ones (label, order, active again) in one statement. */
  async upsert(tx: Database, rows: readonly TargetingOptionWrite[]): Promise<void> {
    if (rows.length === 0) return;
    await tx
      .insert(rvmTargetingOptions)
      .values(rows.map((r) => ({ ...r, active: true })))
      .onConflictDoUpdate({
        target: [rvmTargetingOptions.kind, rvmTargetingOptions.ref],
        set: {
          label: sql`excluded.label`,
          sortOrder: sql`excluded.sort_order`,
          active: true,
          updatedAt: sql`now()`,
        },
      });
  }

  /** Mark the given refs inactive. Never a DELETE. */
  async retire(tx: Database, refs: TargetingOptionRetirement): Promise<void> {
    const byKind: SQL[] = (["branch", "course"] as const)
      .filter((kind) => refs[kind].length > 0)
      .map(
        (kind) =>
          and(
            eq(rvmTargetingOptions.kind, kind),
            inArray(rvmTargetingOptions.ref, [...refs[kind]]),
          )!,
      );
    if (byKind.length === 0) return;
    await tx
      .update(rvmTargetingOptions)
      .set({ active: false, updatedAt: sql`now()` })
      .where(and(eq(rvmTargetingOptions.active, true), or(...byKind)));
  }

  /**
   * The replacement's `audit_logs` row. `entity_id` is the guard's call id: the list has no row id
   * of its own, and the call id is what Campus quotes back. Counts only.
   */
  async writeAudit(tx: Database, callId: string, metadata: Record<string, unknown>): Promise<void> {
    await tx.insert(auditLogs).values({
      actorType: "campus_service",
      actorId: null,
      action: CAMPUS_TARGETING_AUDIT_ACTION,
      entityType: "rvm_targeting_options",
      entityId: callId,
      metadata,
    });
  }
}
