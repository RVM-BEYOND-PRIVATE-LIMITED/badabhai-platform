import { Inject, Injectable } from "@nestjs/common";
import { count, eq } from "drizzle-orm";
import { type Database, profileCorrections, type ProfileCorrection } from "@badabhai/db";

import { DATABASE } from "../database/database.module";
import type { CorrectableField } from "./extracted-corrections.contract";

/**
 * READS AND WRITES `profile_correction` (migration 0117) — the audit fact that a worker
 * corrected an extracted field.
 *
 * One row per corrected field per profile: the profile, the pinned session anchor, the
 * closed field enum, the timestamp. NO VALUES — the corrected values live in the
 * authored stores; a second copy here would be a second source for the sheet. The row
 * is the cap counter (`MAX_CORRECTIONS_PER_PROFILE` counts these) and the
 * `resume.edited` correlation id (`correction_id`).
 *
 * Erasure rides the profile FK cascade: deleting the profile deletes its correction
 * history, which is complete (the `session_id` anchor is opaque and points nowhere).
 *
 * ROW-FIRST ORDERING (see the service): the row is inserted BEFORE the field writes so
 * `worker_confirmed` skill rows can carry it as `evidence_ref`, and it records the
 * ATTEMPT while the `resume.edited` event records completion. Every writer the service
 * calls is replace-or-set (idempotent), so a failed attempt converges on retry instead
 * of forking the readers — no compensation delete, by design.
 */
@Injectable()
export class ProfileCorrectionsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Record one applied correction. Returns the row (its id is the event's `correction_id`). */
  async insertCorrection(input: {
    profileId: string;
    sessionId: string;
    field: CorrectableField;
  }): Promise<ProfileCorrection> {
    const rows = await this.db
      .insert(profileCorrections)
      .values({
        profileId: input.profileId,
        sessionId: input.sessionId,
        field: input.field,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to record profile correction");
    return row;
  }

  /** How many corrections this profile has used — the cap counter. */
  async countByProfile(profileId: string): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(profileCorrections)
      .where(eq(profileCorrections.profileId, profileId));
    return rows[0]?.n ?? 0;
  }
}
