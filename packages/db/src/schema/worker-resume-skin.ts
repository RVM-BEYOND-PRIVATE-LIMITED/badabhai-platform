import { check, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import type { ResumeSkin } from "@badabhai/types";

import { workers } from "./worker";

// ===========================================================================
// worker_resume_skin — the colour skin a worker chose for their résumé (migration 0128)
// ===========================================================================
//
// #1801 (owner ruling 2026-09-28, "Plumbing, Neela only"). ONE ROW PER WORKER, because the
// preference is per worker, not per generated résumé: every future and re-rendered `bb_trade`
// sheet of theirs prints in this skin. No `resume_id` — a résumé row keeps recording only the
// template id it was generated with.
//
// NO ROW MEANS NEELA (`DEFAULT_RESUME_SKIN`), the house style every sheet has printed in since
// `bb_trade` shipped. A row exists only once the worker has explicitly chosen.
//
// A SEPARATE TABLE RATHER THAN A COLUMN ON `workers` OR `generated_resumes`, deliberately. A bare
// select on either names every model column, so a column there would 500 every worker or résumé
// read on a build that reaches the database before the migration does (the 2026-09-10 form
// outage). This table is read and written only by `ResumeSkinRepository`, and only while
// `RESUME_SKINS_ENABLED` is on — so 0128 is apply-before-FLAG-ON, not apply-before-deploy.
//
// NOT PII: an opaque worker id, a closed-set skin, a timestamp. Nothing here crosses the AI
// boundary. Erasure is the cascade on `worker_id`.
//
// ADDITIVE. Rollback: DROP TABLE "worker_resume_skin";
// ===========================================================================
export const workerResumeSkins = pgTable(
  "worker_resume_skin",
  {
    workerId: uuid("worker_id")
      .primaryKey()
      .references(() => workers.id, { onDelete: "cascade" }),
    /** The skin the worker chose — one of `RESUME_SKINS`. */
    skin: text("skin").$type<ResumeSkin>().notNull(),
    /** When the CURRENT skin was chosen (stamped on every real change). */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // `RESUME_SKINS` in @badabhai/types, spelled out because a CHECK is static SQL. A new skin
    // widens this in its own migration, together with its token block and a new event version.
    check("wrs_skin_chk", sql`${t.skin} IN ('neela')`),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0128

export type WorkerResumeSkin = typeof workerResumeSkins.$inferSelect;
export type NewWorkerResumeSkin = typeof workerResumeSkins.$inferInsert;
