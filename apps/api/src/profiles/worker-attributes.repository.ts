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
          // CLEARED ON EVERY WRITE, and that is the whole invalidation rule for the rewrite.
          // No writer of this table ever sets `valueTextPolished`, so `excluded` carries NULL —
          // which means a re-answered question drops the rewrite of the sentence it replaced.
          // Carrying it forward would print last week's English over this week's answer, and the
          // cost of dropping it is one model call on the next render. Same doctrine as the four
          // value columns above: every column this upsert owns is overwritten, never left stale.
          valueTextPolished: sqlExcluded("value_text_polished"),
          // CARRIED WHEN THE ANSWER DID NOT CHANGE, RESET WHEN IT DID — and the asymmetry with
          // the line above is the point, not an inconsistency. The polish is derived data worth
          // one model call; the REFUSAL is the worker's decision and is not re-earned.
          //
          // Clearing it unconditionally would be the #1354 defect arriving through this door:
          // `value_text_polished` is already NULLed above, a null polish is exactly what the
          // polisher reads as "not done yet", and a cleared decline would let the next render
          // silently rewrite the sentence the worker had explicitly chosen to keep. Re-submitting
          // a form without touching that answer is the ordinary way to reach this.
          //
          // KEYED ON THE TEXT, NEVER ON THE ROW — the same rule `replaceForWorker` applies across
          // a history replace, for the same reason: a refusal is about a SENTENCE. An EDITED answer
          // is a different sentence, so it arrives un-refused and is re-polished for free, which
          // is the behaviour the column documents. `IS NOT DISTINCT FROM` rather than `=` because
          // both sides are nullable and NULL = NULL is NULL, which this CASE would read as a
          // changed answer and quietly revoke the decision.
          valueTextPolishedDeclined: sql`CASE WHEN ${workerAttributes.valueText} IS NOT DISTINCT FROM excluded.value_text THEN ${workerAttributes.valueTextPolishedDeclined} ELSE false END`,
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
    polishedAttributes: Record<string, string>;
    declinedAttributes: ReadonlySet<string>;
  }> {
    const rows = await this.db
      .select({
        attributeKey: workerAttributes.attributeKey,
        valueKind: workerAttributes.valueKind,
        valueBool: workerAttributes.valueBool,
        valueNumber: workerAttributes.valueNumber,
        valueText: workerAttributes.valueText,
        valueTextPolished: workerAttributes.valueTextPolished,
        valueTextPolishedDeclined: workerAttributes.valueTextPolishedDeclined,
        valueTextList: workerAttributes.valueTextList,
        packId: workerAttributes.packId,
        updatedAt: workerAttributes.updatedAt,
      })
      .from(workerAttributes)
      .where(eq(workerAttributes.workerId, workerId));

    const attributes: Record<string, unknown> = {};
    // A SECOND MAP, NEVER FOLDED INTO `attributes`. That map means "what the worker answered" and
    // is read by the mapper, the matcher's callers and the fresher block alike; putting a
    // model-composed sentence in it under the same key would make a rewrite indistinguishable
    // from an answer at every one of those readers. Sparse by construction — a key appears here
    // only when a rewrite exists, so `polished[k] ?? attributes[k]` is the whole fallback.
    const polishedAttributes: Record<string, string> = {};
    // A THIRD COLLECTION, AND A SET RATHER THAN A MAP, because the only question any reader has
    // is membership: did this worker refuse the rewrite of this key (#1485). SPARSE on the same
    // terms as `polishedAttributes` — a key appears only when the answer is yes — so a reader that
    // does not know about refusals is unaffected, and `!declined.has(k)` is the whole gate.
    const declinedAttributes = new Set<string>();
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
          if (r.valueTextPolished !== null && r.valueTextPolished.trim() !== "") {
            polishedAttributes[r.attributeKey] = r.valueTextPolished;
          }
          // RECORDED EVEN WHEN THE REWRITE IS GONE. A refusal outlives the polish it was about:
          // the upsert NULLs `value_text_polished` on every re-answer while carrying this flag
          // over unchanged text, so the ordinary state of a refused row is "declined, no polish".
          // Gating this on a present rewrite would drop exactly that row and let the polisher
          // treat it as unfinished work.
          if (r.valueTextPolishedDeclined) declinedAttributes.add(r.attributeKey);
      }
      const at = r.updatedAt?.getTime() ?? 0;
      if (r.packId && at > newest) {
        newest = at;
        packId = r.packId;
      }
    }
    return { packId, attributes, polishedAttributes, declinedAttributes };
  }

  /**
   * Store the model's rewrite of ONE text answer (#1350, extended to the fresher block).
   *
   * SCOPED TO A TEXT ANSWER THAT EXISTS. The `value_kind = 'text'` predicate is belt on the
   * `wa_value_text_polished_chk` brace: the constraint would reject a polish attached to a slug,
   * and matching zero rows here means the caller simply gets `false` instead of an exception
   * thrown into a render. A worker whose answer changed between the read and this write matches
   * nothing for the same reason and is re-polished next time — which is correct, because the
   * rewrite in hand is of a sentence that is no longer there.
   *
   * Returns whether a row was updated, so the caller can say so in a log rather than assume it.
   */
  async saveAttributePolish(
    workerId: string,
    attributeKey: string,
    polished: string,
  ): Promise<boolean> {
    const updated = await this.db
      .update(workerAttributes)
      .set({ valueTextPolished: polished })
      .where(
        and(
          eq(workerAttributes.workerId, workerId),
          eq(workerAttributes.attributeKey, attributeKey),
          eq(workerAttributes.valueKind, "text"),
        ),
      )
      .returning({ id: workerAttributes.id });
    return updated.length > 0;
  }

  /**
   * Record the worker's choice of WHICH text prints for one free-text answer (#1485).
   *
   * THE MITIGATION FOR THE SECTION-8 OVERRIDE ON THE FRESHER PATH, in one statement. #1350 lets a
   * model rewrite `iti_project_work` and print it on the sheet an employer reads; ADR-0039 records
   * that no test can assert the absence of a plausible-but-false sentence. Only the worker knows
   * whether one is true, and a fresher had no way to say so — `setPolishDeclined` addresses an
   * employment row and he has none. This is that route's twin for an attribute.
   *
   * OWNERSHIP IS PROVED IN THE STATEMENT, not checked before it. The attribute key comes from the
   * client, so `worker_id` is in the WHERE: a worker naming a key he has never answered updates
   * zero rows and is told nothing about whether anyone else has. A read-then-write would be the
   * same query twice with a race between them.
   *
   * SCOPED TO A TEXT ANSWER, which is belt on the `wa_value_text_polished_declined_chk` brace.
   * Matching zero rows returns 0 and becomes a 404; the constraint would have raised instead, and
   * an exception is not the answer to a worker naming the wrong key.
   *
   * THE REWRITE IS LEFT WHERE IT IS. Declining does not destroy `value_text_polished`, so a worker
   * who changes his mind costs nothing — the same reason `setPolishDeclined` sets a flag rather
   * than clearing a column.
   *
   * `updated_at` IS DELIBERATELY NOT STAMPED, and that is not an oversight to tidy up later.
   * {@link loadTradeSheet} elects the sheet's `packId` as the `pack_id` of the row with the
   * greatest `updated_at` — its docstring calls that "the interview the worker actually just
   * finished". A REFUSAL IS NOT AN INTERVIEW. A worker holding rows from two role packs (the ITI
   * questions are gated on that trade's tenure, so a second pack answered with experience does not
   * re-ask them) would otherwise have this PUT re-point the whole sheet at the older trade: the
   * template, the workshop-machine labels and the training role label all key off `packId`. A
   * route that chooses which of two sentences prints must not choose the trade.
   *
   * `saveAttributePolish` above leaves the column alone for the same reason, as does #1354's
   * `WorkerEmploymentRepository.setPolishDeclined`. Nothing stamps it on a plain UPDATE either —
   * the column carries `defaultNow()` and no `$onUpdate`, so the three writers agree.
   *
   * Returns how many rows were updated: zero means not this worker's answer, or no such answer.
   */
  async setTextPolishDeclined(
    workerId: string,
    attributeKey: string,
    declined: boolean,
  ): Promise<number> {
    const updated = await this.db
      .update(workerAttributes)
      .set({ valueTextPolishedDeclined: declined })
      .where(
        and(
          eq(workerAttributes.workerId, workerId),
          eq(workerAttributes.attributeKey, attributeKey),
          eq(workerAttributes.valueKind, "text"),
        ),
      )
      .returning({ id: workerAttributes.id });
    return updated.length;
  }
}

/** `excluded.<column>` — the row PostgreSQL would have inserted, for an upsert's SET clause. */
function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}
