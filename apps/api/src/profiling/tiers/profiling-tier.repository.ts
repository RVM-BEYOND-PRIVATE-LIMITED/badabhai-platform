import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  type Database,
  questionPackItems,
  questionPacks,
  workerProfilingTiers,
  type WorkerProfilingTier,
} from "@badabhai/db";
import { isProfilingTier, type ProfilingTier } from "@badabhai/types";

import { DATABASE } from "../../database/database.module";
import type { ItemTierMap } from "./profiling-tier.policy";

/**
 * Tiered profiling's two reads and its writes (migration 0126). DATABASE ACCESS ONLY — what a
 * tier means is `profiling-tier.policy.ts`, and when to change one is `ProfilingTierService`.
 *
 * NOTHING HERE MAY RUN WHILE `PROFILING_TIERS_ENABLED` IS OFF. Both tables it names are 0126's,
 * and 0126 is apply-before-flag-on: callers check the flag first, which is what lets a build
 * reach a database that has not applied the migration without a single failed query.
 *
 * Depends only on the @Global DATABASE, so it is PROVIDED in each module that needs it (the
 * `WorkerAttributesRepository` precedent) rather than exported through a module edge.
 */
@Injectable()
export class ProfilingTierRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The worker's tier row, or null when he has none (read as Hard). */
  async findForWorker(workerId: string): Promise<WorkerProfilingTier | null> {
    const [row] = await this.db
      .select()
      .from(workerProfilingTiers)
      .where(eq(workerProfilingTiers.workerId, workerId))
      .limit(1);
    return row ?? null;
  }

  /**
   * The worker's FIRST choice. Inserts only — a row that already exists (a backfill, or a choice
   * made on a concurrent request) is left exactly as it is, and the stored row is returned so the
   * caller can tell which happened.
   */
  async insertSelected(input: {
    workerId: string;
    tier: ProfilingTier;
    formKind: string;
    chatSessionId: string | null;
    at: Date;
  }): Promise<{ row: WorkerProfilingTier; inserted: boolean }> {
    const [inserted] = await this.db
      .insert(workerProfilingTiers)
      .values({
        workerId: input.workerId,
        tier: input.tier,
        source: "selected",
        formKind: input.formKind,
        chatSessionId: input.chatSessionId,
        selectedAt: input.at,
        createdAt: input.at,
        updatedAt: input.at,
      })
      .onConflictDoNothing({ target: workerProfilingTiers.workerId })
      .returning();
    if (inserted) return { row: inserted, inserted: true };
    const existing = await this.findForWorker(input.workerId);
    if (!existing) throw new Error("worker_profiling_tier insert conflicted but no row exists");
    return { row: existing, inserted: false };
  }

  /**
   * Raise the tier from `from` to `to`. GUARDED ON `from`: two concurrent upgrades cannot both
   * apply, and a stale request can never lower a tier another request already raised. Null when
   * the guard did not match, so the caller re-reads and decides.
   */
  async upgrade(input: {
    workerId: string;
    from: ProfilingTier;
    to: ProfilingTier;
    formKind: string;
    chatSessionId: string | null;
    at: Date;
  }): Promise<WorkerProfilingTier | null> {
    const [row] = await this.db
      .update(workerProfilingTiers)
      .set({
        tier: input.to,
        upgradedFrom: input.from,
        source: "selected",
        formKind: input.formKind,
        chatSessionId: input.chatSessionId,
        selectedAt: input.at,
        updatedAt: input.at,
      })
      .where(
        and(
          eq(workerProfilingTiers.workerId, input.workerId),
          eq(workerProfilingTiers.tier, input.from),
        ),
      )
      .returning();
    return row ?? null;
  }

  /**
   * `question_key` → `min_tier` for one pack version.
   *
   * ITS OWN QUERY, deliberately not a column on the pack load. Packs are cached per version as
   * immutable (`PackCacheService`), while `min_tier` is re-seeded in place, so a tier carried
   * inside a cached pack would go stale until the cache expired. ~20 rows on an indexed key.
   *
   * A value outside the closed set cannot pass `qpi_min_tier_chk`; one that somehow did is read as
   * untagged (Hard) rather than trusted.
   */
  async findItemTiers(packId: string, version: number): Promise<ItemTierMap> {
    const rows = await this.db
      .select({ questionKey: questionPackItems.questionKey, minTier: questionPackItems.minTier })
      .from(questionPackItems)
      .where(and(eq(questionPackItems.packId, packId), eq(questionPackItems.packVersion, version)));
    return toItemTierMap(rows);
  }

  /**
   * The same map for the pack's ACTIVE version — the résumé's read, which knows the pack a
   * worker's sheet renders as but not the version he answered. `question_key` is stable across
   * versions, so the active version's tags are the right ones to render by.
   */
  async findActiveItemTiers(packId: string): Promise<ItemTierMap> {
    const rows = await this.db
      .select({ questionKey: questionPackItems.questionKey, minTier: questionPackItems.minTier })
      .from(questionPackItems)
      .innerJoin(
        questionPacks,
        and(
          eq(questionPacks.packId, questionPackItems.packId),
          eq(questionPacks.version, questionPackItems.packVersion),
        ),
      )
      .where(and(eq(questionPackItems.packId, packId), eq(questionPacks.status, "active")));
    return toItemTierMap(rows);
  }
}

function toItemTierMap(
  rows: readonly { questionKey: string; minTier: string | null }[],
): ItemTierMap {
  return new Map(
    rows.map((row) => [row.questionKey, isProfilingTier(row.minTier) ? row.minTier : null]),
  );
}
