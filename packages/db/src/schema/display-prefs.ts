import { sql } from "drizzle-orm";
import { check, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

import type { DisplayPrefsSubjectKind, DisplayTheme } from "@badabhai/types";

// ===========================================================================
// display_prefs — one login's display preference, today the theme (migration 0165, #2819)
// ===========================================================================
//
// ONE ROW PER LOGIN, keyed (subject_kind, subject_id): a worker (`workers.id`), a company or
// agency login (`payers.id`) or an admin (`admin_users.id`), always the id the realm's auth guard
// attached. A payer row is the PERSON's choice, not the company's: keyed on the login, never on
// the tenant key, so two teammates keep two themes (ORG_TENANCY_PLAN §4).
//
// NO ROW MEANS LIGHT (`DEFAULT_DISPLAY_THEME`), what every app shows today. A row exists only once
// the login has chosen something else. While `THEME_ROLLOUT` is closed for a login the api neither
// reads nor writes its row, so a stored choice waits for the switch to open again.
//
// NO FOREIGN KEY, on purpose: `subject_id` names a row in one of THREE tables, so no single FK
// fits, and no cascade erases the row. NO ERASURE PATH NAMES IT YET (#2837, risk R88): naming it
// in the worker's hard delete before 0165 is applied would roll every worker erasure back on
// 42P01. Once 0164 and 0165 are applied, #2837 deletes this row and the login's
// `feature_pilot_subjects` rows in `hardDelete`'s transaction (and in the payer account
// deletion's). No admin deletion exists; an admin is suspended.
//
// NOT PII: an opaque id, two closed enums and two timestamps. Nothing here crosses the AI boundary.
// ===========================================================================
export const displayPrefs = pgTable(
  "display_prefs",
  {
    subjectKind: text("subject_kind").$type<DisplayPrefsSubjectKind>().notNull(),
    subjectId: uuid("subject_id").notNull(),
    /** One of `DISPLAY_THEMES`. */
    theme: text("theme").$type<DisplayTheme>().notNull().default("light"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** When the CURRENT theme was chosen (stamped on every real change). */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "display_prefs_pk", columns: [t.subjectKind, t.subjectId] }),
    // `DISPLAY_PREFS_SUBJECT_KINDS` and `DISPLAY_THEMES` in @badabhai/types, spelled out because a
    // CHECK is static SQL. A new value widens these in its own migration, with a new event version.
    check(
      "display_prefs_subject_kind_chk",
      sql`${t.subjectKind} IN ('worker', 'payer_user', 'admin')`,
    ),
    check("display_prefs_theme_chk", sql`${t.theme} IN ('light', 'dark', 'system')`),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + four REVOKEs carried by migration 0165

export type DisplayPrefsRow = typeof displayPrefs.$inferSelect;
