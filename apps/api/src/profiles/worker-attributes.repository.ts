import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { type Database, workerAttributes, type NewWorkerAttribute } from "@badabhai/db";

import { DATABASE } from "../database/database.module";

/**
 * Writes for `worker_attributes` — the destination for the 77% of the pack corpus that is
 * `target_kind: "attribute"`.
 *
 * WHY THIS FILE EXISTS AT ALL, AND WHY IT DID NOT. Migration 0071 created the table and
 * `answer-map-projector.ts` learned to fill a `ProjectedAttribute[]`. Nothing joined the two: the
 * extraction processor called `toExtractionOutput(projection)`, which reads `projection.draft` and
 * nothing else, so the attributes array was computed on every interview and dropped on the floor.
 * A live 13-turn welding interview produced 10 typed answers and **zero** rows here.
 *
 * That is the ORIGINAL 77% defect, moved one layer later and no less total. The whole point of the
 * table was that `workplace_type`, `tools_owned` and `safety_training` are matching inputs (§2:
 * skills, domain relevance, role-specific experience); an unwritten row ranks nobody.
 */
@Injectable()
export class WorkerAttributesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Upsert every attribute for one worker in ONE statement.
   *
   * ONE ROUND TRIP, not one per attribute. A welding interview settles 8–9 attributes and this
   * runs inside the flush transaction beside the profile write — nine sequential INSERTs would
   * hold row locks across nine network hops while the worker waits on their closing reply, which
   * is the per-turn cost the whole flush-at-end design exists to avoid.
   *
   * UPSERT ON `wa_worker_key_uq`, NOT INSERT. A worker can be interviewed more than once: a
   * re-interview under a newer pack must REPLACE their `workplace_type`, not accumulate a second
   * row the matcher would have to disambiguate. That is also what makes the extraction job's
   * retry safe — the second attempt writes the same values over the same rows.
   *
   * EVERY VALUE COLUMN IS OVERWRITTEN, including the three that are NULL for a given `value_kind`.
   * A worker who answered `experience_years` numerically and later answers it as text would
   * otherwise keep a stale `value_number` beside the new `value_text`, and
   * `wa_value_present_chk` — which demands exactly one populated column, and the one `value_kind`
   * names — would reject the row. Writing all four is what keeps the constraint satisfiable.
   *
   * `updatedAt` is stamped explicitly because `$onUpdate` does not fire through `onConflictDoUpdate`.
   */
  async upsertMany(rows: NewWorkerAttribute[], tx?: Database): Promise<number> {
    if (rows.length === 0) return 0;
    const written = await (tx ?? this.db)
      .insert(workerAttributes)
      .values(rows)
      .onConflictDoUpdate({
        target: [workerAttributes.workerId, workerAttributes.attributeKey],
        set: {
          valueKind: sqlExcluded("value_kind"),
          valueBool: sqlExcluded("value_bool"),
          valueNumber: sqlExcluded("value_number"),
          valueText: sqlExcluded("value_text"),
          valueTextList: sqlExcluded("value_text_list"),
          source: sqlExcluded("source"),
          questionKey: sqlExcluded("question_key"),
          packId: sqlExcluded("pack_id"),
          packVersion: sqlExcluded("pack_version"),
          sessionId: sqlExcluded("session_id"),
          updatedAt: new Date(),
        },
      })
      .returning({ id: workerAttributes.id });
    return written.length;
  }
}

/** `excluded.<column>` — the row PostgreSQL would have inserted, for an upsert's SET clause. */
function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}
