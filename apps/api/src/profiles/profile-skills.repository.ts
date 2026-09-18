import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
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
   */
  async replaceForProfile(
    profileId: string,
    skillIds: readonly string[],
    evidenceRef: string,
  ): Promise<{ skillsWritten: number }> {
    return this.db.transaction(async (tx) => {
      await tx
        .delete(workerProfileSkills)
        .where(eq(workerProfileSkills.workerProfileId, profileId));
      if (skillIds.length > 0) {
        await tx.insert(workerProfileSkills).values(
          skillIds.map((skillId) => ({
            workerProfileId: profileId,
            skillId,
            confidence: null,
            source: "worker_confirmed" as const,
            evidenceRef,
            monthsExperience: null,
            level: null,
          })),
        );
      }
      return { skillsWritten: skillIds.length };
    });
  }
}
