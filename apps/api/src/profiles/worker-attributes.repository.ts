import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
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

  /**
   * Remove named attributes for one worker — how the finishing form CLEARS an answer.
   *
   * A DELETE AND NOT A NULL, because `wa_value_present_chk` demands exactly one populated value
   * column: there is no legal row that says "this worker has no answer to `job_type`". Absence
   * is the only representation of an unanswered attribute the schema permits, so un-ticking a
   * chip has to remove the row. That is also why it is a separate call rather than a null inside
   * `upsertMany` — the constraint makes the two operations genuinely different, and hiding one
   * inside the other would put a `null` branch on the hot interview-flush path that only the
   * form can ever take.
   *
   * SCOPED TO ONE WORKER AND AN EXPLICIT KEY LIST. There is no shape here that clears a worker's
   * whole attribute set, which is the accident this signature exists to make unavailable.
   */
  async deleteKeys(workerId: string, keys: readonly string[], tx?: Database): Promise<number> {
    if (keys.length === 0) return 0;
    const removed = await (tx ?? this.db)
      .delete(workerAttributes)
      .where(
        and(
          eq(workerAttributes.workerId, workerId),
          inArray(workerAttributes.attributeKey, [...keys]),
        ),
      )
      .returning({ id: workerAttributes.id });
    return removed.length;
  }

  /**
   * Read one worker's settled attributes back, for the résumé's trade capability block.
   *
   * THE MISSING HALF OF THIS FILE. Everything above writes; nothing read, so the 77% of the pack
   * corpus that lands here reached the matcher and never reached the worker's own sheet. The
   * `bb_trade` layout's first section IS these values — a turner's machines, controllers,
   * materials, setting operations and tolerance — and without this it renders empty for everyone.
   *
   * THE PACK IS THE MOST RECENT ONE, not an arbitrary row's. `wa_worker_key_uq` is per attribute,
   * so a worker re-interviewed under a newer pack carries rows from BOTH: the upsert replaces a
   * key it asks again and leaves any key the new pack dropped. Picking by `updatedAt` means the
   * sheet describes the interview the worker actually just finished, and picking the row-count
   * majority instead would let a long-retired pack outvote it.
   *
   * VALUES ARE RETURNED IN THE SHAPE THE MAPPER ALREADY EXPECTS — a bare string for a
   * single-select, a string array for a multi-select — which is the same asymmetry
   * `answer-capture.ts` creates on the way in. Reshaping it here would just move the branch.
   */
  async loadTradeSheet(workerId: string): Promise<{
    packId: string | null;
    attributes: Record<string, unknown>;
  }> {
    const rows = await this.db
      .select({
        attributeKey: workerAttributes.attributeKey,
        valueKind: workerAttributes.valueKind,
        valueBool: workerAttributes.valueBool,
        valueNumber: workerAttributes.valueNumber,
        valueText: workerAttributes.valueText,
        valueTextList: workerAttributes.valueTextList,
        packId: workerAttributes.packId,
        updatedAt: workerAttributes.updatedAt,
      })
      .from(workerAttributes)
      .where(eq(workerAttributes.workerId, workerId));

    const attributes: Record<string, unknown> = {};
    let packId: string | null = null;
    let newest = -Infinity;
    for (const r of rows) {
      switch (r.valueKind) {
        case "text_list":
          // `?? []` rather than skipping: an empty multi-select is a real answer ("none of
          // these"), and the mapper drops it on its own by finding no labels.
          attributes[r.attributeKey] = r.valueTextList ?? [];
          break;
        case "boolean":
          attributes[r.attributeKey] = r.valueBool;
          break;
        case "number":
          // `numeric` comes back as a STRING from pg — the driver refuses to lose precision on a
          // 14,4 column. `Number()` here, because every consumer of an attribute value compares
          // it against a JS number and `"2" >= 2` is a comparison nobody wrote on purpose.
          attributes[r.attributeKey] = r.valueNumber === null ? null : Number(r.valueNumber);
          break;
        default:
          attributes[r.attributeKey] = r.valueText;
      }
      const at = r.updatedAt?.getTime() ?? 0;
      if (r.packId && at > newest) {
        newest = at;
        packId = r.packId;
      }
    }
    return { packId, attributes };
  }
}

/** `excluded.<column>` — the row PostgreSQL would have inserted, for an upsert's SET clause. */
function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}
