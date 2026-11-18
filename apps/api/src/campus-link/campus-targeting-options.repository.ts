import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { auditLogs, rvmTargetingOptions, type Database, type RvmTargetingKind } from "@badabhai/db";
import { redactQueryParams } from "../common/db-error";
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

/**
 * Where a list's `as_of` stands against the last list applied: `none` when nothing was ever
 * applied (no row), else `newer` / `same` / `older`, compared in Postgres to the microsecond.
 */
export type ListTiming = "none" | "newer" | "same" | "older";

/** `audit_logs.action` of a targeting-options replacement. */
export const CAMPUS_TARGETING_AUDIT_ACTION = "campus_link.targeting_options_set";

/**
 * Serialises replacements. Two concurrent full-list PUTs would otherwise interleave their upserts
 * and retirements row by row and leave a list neither of them sent.
 */
const REPLACE_LOCK_KEY = "rvm_targeting_options:replace";

/**
 * #2746 PR 5 — the branches and courses a company may target (`rvm_targeting_options`), as Campus
 * replaces them (`PUT targeting-options`). DATABASE ACCESS ONLY: what is added, updated or retired,
 * and whether a list is new enough to apply, is `CampusTargetingOptionsService`'s decision.
 * NOTHING HERE DELETES: postings hold the refs, so an option that leaves Campus's list is only
 * marked inactive.
 *
 * `updated_at` IS CAMPUS'S `as_of`. Every applied PUT stamps EVERY row, listed or retired, with
 * the list's `as_of` ({@link stampAll}), so `max(updated_at)` is the `as_of` of the last list
 * applied: the high-water mark a late retry is compared with ({@link listTiming}). It is Campus's
 * clock, not BadaBhai's, and no other code writes or reads it, so the column needs no migration.
 *
 * Statements that bind labels rethrow a database error through `redactQueryParams`.
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

  /** `asOf` against the last applied list's `as_of`. Read after {@link lockForReplace}. */
  async listTiming(tx: Database, asOf: string): Promise<ListTiming> {
    const rows = (await tx.execute(sql`
      SELECT CASE WHEN max(${rvmTargetingOptions.updatedAt}) IS NULL THEN 'none'
                  WHEN ${asOf}::timestamptz > max(${rvmTargetingOptions.updatedAt}) THEN 'newer'
                  WHEN ${asOf}::timestamptz = max(${rvmTargetingOptions.updatedAt}) THEN 'same'
                  ELSE 'older' END AS "timing"
        FROM ${rvmTargetingOptions}`)) as unknown as { timing: ListTiming }[];
    return rows[0]?.timing ?? "none";
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

  /**
   * Insert new options and rewrite known ones (label, order, active again) in one statement,
   * stamped with the list's `as_of`.
   */
  async upsert(tx: Database, rows: readonly TargetingOptionWrite[], asOf: string): Promise<void> {
    if (rows.length === 0) return;
    const stamp = sql`${asOf}::timestamptz`;
    try {
      await tx
        .insert(rvmTargetingOptions)
        .values(rows.map((r) => ({ ...r, active: true, updatedAt: stamp })))
        .onConflictDoUpdate({
          target: [rvmTargetingOptions.kind, rvmTargetingOptions.ref],
          set: {
            label: sql`excluded.label`,
            sortOrder: sql`excluded.sort_order`,
            active: true,
            updatedAt: stamp,
          },
        });
    } catch (err) {
      throw redactQueryParams(err, "campus targeting options upsert");
    }
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
    try {
      await tx
        .update(rvmTargetingOptions)
        .set({ active: false })
        .where(and(eq(rvmTargetingOptions.active, true), or(...byKind)));
    } catch (err) {
      throw redactQueryParams(err, "campus targeting options retire");
    }
  }

  /** Stamp EVERY row with the applied list's `as_of`: the high-water mark (see the class note). */
  async stampAll(tx: Database, asOf: string): Promise<void> {
    await tx
      .update(rvmTargetingOptions)
      .set({ updatedAt: sql`${asOf}::timestamptz` })
      .where(sql`${rvmTargetingOptions.updatedAt} IS DISTINCT FROM ${asOf}::timestamptz`);
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
