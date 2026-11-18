import { sql } from "drizzle-orm";
import { check, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { payers } from "./payer";

/**
 * The pilot list (#2746 item 1): which companies may use a feature whose switch reads `pilot`.
 * One row per (feature, company). `payer_id` is the TENANT key (`PayerTenantScopeService`): with
 * `PAYER_ORG_TENANCY_MODE=on` the company's anchor, so a team member inherits its pilot place; in
 * `off` / `shadow` the login itself, so list each login. Feature names are a closed list in the API
 * (`FEATURE_ROLLOUT_KEYS`), not here: #2747–#2750 add theirs without a migration, and the shape
 * CHECK keeps a typo from passing as a new name.
 *
 * This list will gate real payments (#2749), so every row says who added it and why. Written by
 * hand (owner SQL) or by a later admin route, never by a company. Readers fail closed: a read
 * error means "not on the pilot".
 */
export const featurePilotPayers = pgTable(
  "feature_pilot_payers",
  {
    feature: text("feature").notNull(),
    payerId: uuid("payer_id")
      .notNull()
      .references(() => payers.id, { onDelete: "cascade" }),
    /**
     * Who put the company on the pilot: an admin id or a fixed token such as `owner_sql`, never
     * a person's name (`fpp_added_by_chk` admits the id charset only).
     */
    addedBy: text("added_by").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "feature_pilot_payers_pk", columns: [t.feature, t.payerId] }),
    check("fpp_feature_chk", sql`${t.feature} ~ '^[a-z][a-z0-9_]{1,63}$'`),
    check("fpp_added_by_chk", sql`${t.addedBy} ~ '^[A-Za-z0-9._:-]{1,128}$'`),
    check("fpp_reason_chk", sql`char_length(${t.reason}) BETWEEN 1 AND 500`),
  ],
).enableRLS();

/** The logins a pilot can name one by one; a company is listed by tenant key above instead. */
export const FEATURE_PILOT_SUBJECT_KINDS = ["worker", "admin"] as const;
export type FeaturePilotSubjectKind = (typeof FEATURE_PILOT_SUBJECT_KINDS)[number];

/**
 * The pilot list for the logins that are not a company (#2820): one row per (feature, kind,
 * login). `subject_id` is `workers.id` for a worker and `admin_users.id` for an admin, always the
 * id the auth guard put on the request. The company list keeps its tenant meaning, so a company is
 * never listed here.
 *
 * NO FOREIGN KEY, on purpose. One column names a row in one of two tables, so no single FK fits,
 * and a pilot row must never block or delay deleting a worker (a DPDP erasure) or an admin. So no
 * cascade erases it: every worker deletion path deletes his rows itself, on its own transaction
 * (`eraseLoginKeyedRows` in the api, #2837, risk R87). No admin deletion exists. `reason` still
 * never names the person (an owner may type it, and it is read beside the id); say why the login
 * is piloted, not who it is.
 *
 * Same rules as the company list: `added_by` and `reason` on every row, written by the owner
 * (SQL) or a later admin route, never by the login itself, and a read error means "not listed".
 */
export const featurePilotSubjects = pgTable(
  "feature_pilot_subjects",
  {
    feature: text("feature").notNull(),
    subjectKind: text("subject_kind").$type<FeaturePilotSubjectKind>().notNull(),
    subjectId: uuid("subject_id").notNull(),
    /** As `feature_pilot_payers.added_by`: an admin id or a fixed token, never a name. */
    addedBy: text("added_by").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "feature_pilot_subjects_pk",
      columns: [t.feature, t.subjectKind, t.subjectId],
    }),
    check("fps_feature_chk", sql`${t.feature} ~ '^[a-z][a-z0-9_]{1,63}$'`),
    check("fps_subject_kind_chk", sql`${t.subjectKind} IN ('worker', 'admin')`),
    check("fps_added_by_chk", sql`${t.addedBy} ~ '^[A-Za-z0-9._:-]{1,128}$'`),
    check("fps_reason_chk", sql`char_length(${t.reason}) BETWEEN 1 AND 500`),
  ],
).enableRLS();
