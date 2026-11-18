import { Inject, Injectable } from "@nestjs/common";
import { sql as dsql } from "drizzle-orm";
import { studentVisibilityPresent, type Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";

/**
 * #2887 — the per-field source marker (`worker_field_sources`): who wrote a profile field last,
 * the import or the worker himself on BadaBhai. Ruling 4 (17 Nov 2026): a field the worker edited
 * is NEVER overwritten by a later sync. Keys are the admin override fact keys
 * (`WORKER_ADMIN_OVERRIDE_FACT_KEYS`), the vocabulary every self-edit path already names.
 *
 * Used only while STUDENT_MOVE_ENABLED is on. Every writer checks the table is there first (the
 * switch can be set before the migration), because a statement naming a missing table would abort
 * the caller's whole transaction — here, the worker's own edit.
 */

const FIELD_KEY = /^[a-z_]{1,64}$/;

function checkedKeys(keys: readonly string[]): string[] {
  const unique = [...new Set(keys)];
  for (const key of unique) {
    if (!FIELD_KEY.test(key)) throw new Error(`worker_field_sources: bad field key ${key}`);
  }
  return unique;
}

/**
 * The worker edited these fields himself: mark them his, on the edit's own transaction. A no-op
 * (no statement) when the table is missing. The upsert always wins: the worker's edit is final.
 */
export async function markWorkerEditedWithin(
  executor: Database,
  workerId: string,
  keys: readonly string[],
): Promise<void> {
  const fields = checkedKeys(keys);
  if (fields.length === 0) return;
  if (!(await studentVisibilityPresent(executor))) return;
  await executor.execute(dsql`
    INSERT INTO worker_field_sources (worker_id, field_key, source, batch_id, updated_at)
    SELECT ${workerId}::uuid, k, 'worker', NULL, now()
    FROM unnest(${dsql.param(fields)}::text[]) AS k
    ON CONFLICT (worker_id, field_key) DO UPDATE
      SET source = 'worker', batch_id = NULL, updated_at = now()
  `);
}

/** The import side of the marker (#2887 part 3's CLI is its caller). */
@Injectable()
export class WorkerFieldSourcesRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Of `keys`, the ones the import may still write: every key the worker has not edited. */
  async importableFields(
    workerId: string,
    keys: readonly string[],
    executor: Database = this.db,
  ): Promise<Set<string>> {
    const fields = checkedKeys(keys);
    const rows = (await executor.execute(dsql`
      SELECT field_key FROM worker_field_sources
      WHERE worker_id = ${workerId}::uuid
        AND source = 'worker'
        AND field_key = ANY(${dsql.param(fields)}::text[])
    `)) as unknown as { field_key: string }[];
    const theirs = new Set(rows.map((r) => r.field_key));
    return new Set(fields.filter((k) => !theirs.has(k)));
  }

  /** May the import write this one field? False once the worker has edited it. */
  async canImportField(workerId: string, key: string, executor: Database = this.db): Promise<boolean> {
    return (await this.importableFields(workerId, [key], executor)).has(key);
  }

  /**
   * The import wrote these fields in `batchId`. A field the worker already owns is left his: the
   * conflict update only applies where the stored source is still the import's.
   */
  async markImported(
    tx: Database,
    workerId: string,
    keys: readonly string[],
    batchId: string,
  ): Promise<void> {
    const fields = checkedKeys(keys);
    if (fields.length === 0) return;
    await tx.execute(dsql`
      INSERT INTO worker_field_sources (worker_id, field_key, source, batch_id, updated_at)
      SELECT ${workerId}::uuid, k, 'campus_import', ${batchId}::uuid, now()
      FROM unnest(${dsql.param(fields)}::text[]) AS k
      ON CONFLICT (worker_id, field_key) DO UPDATE
        SET batch_id = EXCLUDED.batch_id, updated_at = now()
        WHERE worker_field_sources.source = 'campus_import'
    `);
  }
}
