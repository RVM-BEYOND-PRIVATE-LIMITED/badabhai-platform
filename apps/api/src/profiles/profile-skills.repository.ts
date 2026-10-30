import { Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import type { TradeLevel } from "@badabhai/taxonomy";
import { type Database, workerProfileSkills } from "@badabhai/db";

import { DATABASE } from "../database/database.module";

/**
 * WRITES `worker_profile_skill` (migration 0076) — the AUTHORED worker skill relation.
 *
 * The first writer this table has ever had on the request path: until the correction
 * contract, every row source the CHECK allows (`llm_extraction`, `worker_confirmed`,
 * `ops`) had no producer, and the display (`worker_profiles.skills`) plus the match
 * rebuild read past it. Corrections write `worker_confirmed` rows here AND update the
 * display column (via `ProfilesRepository`) AND trigger the quiet rebuild — the
 * authored/display/derived triple stays consistent by construction rather than by a
 * re-projector that does not exist yet.
 *
 * REPLACE semantics in ONE transaction (delete-then-insert, the occupations-page
 * shape): the correction carries the worker's FULL corrected list, so a removed id
 * must actually leave rather than linger beside the kept ones.
 */
@Injectable()
export class ProfileSkillsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Replace one profile's worker-confirmed skill rows with the corrected set.
   *
   * `confidence` stays NULL (a machine confidence on a human assertion would be a
   * fiction — the column's own contract); `evidenceRef` carries the correction row id
   * (the opaque artifact that evidenced these rows, per the column's privacy rule).
   * Extraction-sourced rows for the same profile are superseded by the replace: the
   * corrected list IS the current truth, and keeping both would double-count the
   * worker's supply under two sources.
   *
   * PRESERVES `trade_level` / `level_confirmed` for skill ids the corrected list
   * keeps (Middle Way P5). The rung is the worker's own stated answer from an
   * interview, not a claim the correction re-decides; wiping it on every correction
   * would un-state a level the worker stated. Skill ids the list drops leave
   * entirely, rungs with them.
   */
  async replaceForProfile(
    profileId: string,
    skillIds: readonly string[],
    evidenceRef: string,
  ): Promise<{ skillsWritten: number }> {
    return this.db.transaction(async (tx) => {
      const kept =
        skillIds.length === 0
          ? []
          : await tx
              .select({
                skillId: workerProfileSkills.skillId,
                tradeLevel: workerProfileSkills.tradeLevel,
                levelConfirmed: workerProfileSkills.levelConfirmed,
              })
              .from(workerProfileSkills)
              .where(eq(workerProfileSkills.workerProfileId, profileId));
      const rungBySkill = new Map(kept.map((r) => [r.skillId, r]));
      await tx
        .delete(workerProfileSkills)
        .where(eq(workerProfileSkills.workerProfileId, profileId));
      if (skillIds.length > 0) {
        await tx.insert(workerProfileSkills).values(
          skillIds.map((skillId) => {
            const rung = rungBySkill.get(skillId);
            return {
              workerProfileId: profileId,
              skillId,
              confidence: null,
              source: "worker_confirmed" as const,
              evidenceRef,
              monthsExperience: null,
              level: null,
              // A correction confirms the LIST, not the rung — the kept rung rides
              // along, and a skill the worker never levelled stays NULL/unconfirmed.
              tradeLevel: rung?.tradeLevel ?? null,
              levelConfirmed: rung?.levelConfirmed ?? false,
            };
          }),
        );
      }
      return { skillsWritten: skillIds.length };
    });
  }

  /**
   * Write one profile's trade rungs from its level answers (Middle Way P5 persist).
   *
   * UPSERT PER (profile, skill), touching ONLY the rung columns. A row the worker's
   * corrections already own keeps its source, confidence, evidence and months; a row
   * nobody owns is inserted as `worker_confirmed` (the rung IS the worker's own
   * stated answer). Never deletes, never touches another skill, never writes the
   * display column — the rung is display-only and must not move reach or rank.
   *
   * Idempotent: re-running the same extraction writes the same rung over itself.
   */
  async upsertTradeLevels(
    profileId: string,
    entries: readonly { skillId: string; tradeLevel: TradeLevel; levelConfirmed: boolean }[],
    evidenceRef: string | null,
  ): Promise<{ levelsWritten: number }> {
    if (entries.length === 0) return { levelsWritten: 0 };
    await this.db
      .insert(workerProfileSkills)
      .values(
        entries.map((entry) => ({
          workerProfileId: profileId,
          skillId: entry.skillId,
          confidence: null,
          source: "worker_confirmed" as const,
          evidenceRef,
          monthsExperience: null,
          level: null,
          tradeLevel: entry.tradeLevel,
          levelConfirmed: entry.levelConfirmed,
        })),
      )
      .onConflictDoUpdate({
        target: [workerProfileSkills.workerProfileId, workerProfileSkills.skillId],
        // Per-row: the rung the worker just stated wins over the stored one. Every
        // other column is left byte-identical — a correction's confidence, evidence
        // and months are not this writer's to touch.
        set: {
          tradeLevel: sql.raw("excluded.trade_level"),
          levelConfirmed: sql.raw("excluded.level_confirmed"),
        },
      });
    return { levelsWritten: entries.length };
  }
}
