import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { workerProfiles } from "./profile";

// ===========================================================================
// profile_correction — the audit fact that a worker corrected an extracted field
// ===========================================================================
//
// #1311 backend half (migration 0117). One row per corrected field per profile. The
// corrected VALUES live in the authored stores (never here) — this row is the cap
// counter and the `resume.edited` correlation id. See the migration header for the
// full contract (field→writer mapping, opaque session anchor, erasure path).
//
// `field` is CLOSED here AND in the DTO AND in the event enum — a sixth field needs
// all three changed together, deliberately. Membership of skill/machine ids is the
// DTO's job against @badabhai/taxonomy (the 0114 split: shape in SQL, membership in
// TypeScript), so a new skill never needs a migration.
//
// ADDITIVE / BACKWARD-COMPATIBLE. One new, empty table; a profile with no rows
// confirms and generates exactly as before. Rollback: DROP TABLE "profile_correction";
//
// NOT PII: opaque profile/session ids, a closed field enum, a timestamp. The rows never
// cross the AI boundary.
// ===========================================================================
export const profileCorrections = pgTable(
  "profile_correction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => workerProfiles.id, { onDelete: "cascade" }),
    /** The pinned interview the correction was validated against — opaque, never a join. */
    sessionId: uuid("session_id").notNull(),
    /** One of skills|machines|experience|education|certificates. */
    field: text("field").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "pc_field_chk",
      sql`${t.field} IN ('skills','machines','experience','education','certificates')`,
    ),
    // Cap counting (`count(*) ... where profile_id`) and correction history per profile.
    index("pc_profile_idx").on(t.profileId),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0117

export type ProfileCorrection = typeof profileCorrections.$inferSelect;
export type NewProfileCorrection = typeof profileCorrections.$inferInsert;
