import { sql as dsql, type SQL } from "drizzle-orm";
import type { Database } from "./client";

/**
 * #2887 — the bulk student move's visibility switch, as the SQL the reach and search statements
 * splice in. A moved student has one `student_visibility` row; `visible` is false at import and an
 * admin turns it on. A worker with no row was never moved and is never affected.
 *
 * The reach statements ask {@link studentVisibilityPresent} and splice the filter in whenever the
 * table exists, never on a switch (reach depends on none, #2746 M2): before the migration no
 * statement names it, and once it exists only an imported student can have a row. Search, the open
 * gate and the pre-pay facts use these helpers only while STUDENT_MOVE_ENABLED is on.
 */

/** `<worker>` is NOT a hidden moved student (no row, or `visible`). */
export function notHiddenStudent(workerId: SQL): SQL {
  return dsql`NOT EXISTS (
            SELECT 1 FROM student_visibility sv
            WHERE sv.worker_id = ${workerId} AND NOT sv.visible
          )`;
}

/** `<worker>` IS a hidden moved student. */
export function isHiddenStudent(workerId: SQL): SQL {
  return dsql`EXISTS (
            SELECT 1 FROM student_visibility sv
            WHERE sv.worker_id = ${workerId} AND NOT sv.visible
          )`;
}

/** `<worker>` is a moved student whose visibility an admin turned ON. */
export function isVisibleStudent(workerId: SQL): SQL {
  return dsql`EXISTS (
            SELECT 1 FROM student_visibility sv
            WHERE sv.worker_id = ${workerId} AND sv.visible
          )`;
}

/**
 * Is `student_visibility` there? The switch can be on before the migration is applied; a
 * statement naming a missing table fails the whole transaction (42P01), so every caller asks this
 * first and runs its switch-off statement when the answer is no. `to_regclass` is a catalogue
 * lookup: cheap, and it never errors on a missing name.
 */
export async function studentVisibilityPresent(executor: Pick<Database, "execute">): Promise<boolean> {
  const rows = (await executor.execute(
    dsql`SELECT to_regclass('public.student_visibility') IS NOT NULL AS present`,
  )) as unknown as { present?: unknown }[];
  return rows[0]?.present === true;
}
