import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { workers } from "./worker";

/**
 * WORK HISTORY (migration 0094) — the employers a worker names, and the roles held inside them.
 *
 * TWO TABLES BECAUSE A PROMOTION IS NOT TWO JOBS. The ratified résumé design prints a worker who
 * moved from Operator to Setter-cum-Operator inside one company as ONE employer block with two
 * dated role lines (design guideline §11 #14), because progression is a strong pay signal and a
 * flat list destroys it — the same tenure reads as job-hopping instead.
 *
 *     workers 1 --< worker_employment 1 --< worker_employment_role
 *
 * WHY THIS COULD NOT LIVE ON THE EXISTING SHAPE. `resume_profile.experiences[]` is a role, a
 * duration in the worker's own words, and what they did. It carries NO EMPLOYER by contract:
 * `ExperienceEntrySchema` is `.strict()`, and `pseudonymize.py` masks employers to `[EMPLOYER_n]`
 * before any model sees a transcript. There is no field for one and nothing upstream could fill
 * it. The value arrives instead from a question the WORKER TYPES, written straight to Postgres,
 * never through the AI service — owner ruling 2026-08-28. The gateway mask is unchanged.
 */

/**
 * One employer. `employer_name_enc` is an AES-256-GCM token, never plaintext.
 *
 * ENCRYPTED FOR THE SAME REASON `workers.full_name` IS. "Ramesh worked at Sandhar Technologies
 * from January 2023" is personal data about a worker under DPDP even though the company name on
 * its own is not, and this is the first table to hold anyone's employment record.
 *
 * THE COST IS REAL AND IS ACCEPTED: an encrypted column cannot be indexed, grouped or joined, so
 * there is no employer dedupe, no "how many of our workers came from Sandhar", and an EPFO
 * tenure-verification pass would have to decrypt row by row. If any of those becomes a
 * requirement the answer is a separate canonical `employer` table with a surrogate id — never
 * decrypting this column.
 *
 * `employerCity` / `employerState` are deliberately NOT encrypted: both already print on the
 * résumé and on the payer-facing disclosure, and a city is not an identifier.
 */
export const workerEmployment = pgTable(
  "worker_employment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    /** AES-256-GCM ciphertext token (see above). NEVER read without `PiiCryptoService`. */
    employerNameEnc: text("employer_name_enc").notNull(),
    employerCity: text("employer_city"),
    employerState: text("employer_state"),
    /**
     * 'YYYY-MM', or null.
     *
     * A MONTH, NOT A DATE, because that is the precision a worker actually has. Asking a turner
     * for the day he joined in 2018 produces a guess, and §11 #3 forbids putting a guess on the
     * page. Text rather than `date` so "no day" is representable without inventing the 1st.
     */
    startYm: text("start_ym"),
    /** Null means CURRENT — a real state, not missing data. See {@link durationStated}. */
    endYm: text("end_ym"),
    /**
     * False when the worker could not give dates at all.
     *
     * THE DISTINCTION NULL CANNOT MAKE. `endYm IS NULL` means "still there"; a worker who says
     * "kuch saal" has no start either, and §11 #3 requires that to render as the literal
     * "duration not stated" — never estimated, never rounded, never silently omitted. Without
     * this column those two states are one, and the honest one is unprintable.
     */
    durationStated: boolean("duration_stated").notNull().default(true),
    /**
     * Display order, most recent first.
     *
     * EXPLICIT, NOT DERIVED FROM DATES. Two jobs can start in the same month, and a worker whose
     * dates are unstated still described them in an order. Sorting by date would reshuffle those
     * rows between renders and make every regenerated PDF a false diff.
     */
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // §11 #4 — contract or thekedar work with no company name renders the site or plant, else
    // the literal "contract work". The field is NEVER blank and is NEVER invented, so the column
    // is NOT NULL and the caller must already have decided which of the two it is.
    check("we_employer_name_present_chk", sql`length(btrim(${t.employerNameEnc})) > 0`),
    check("we_city_len_chk", sql`${t.employerCity} IS NULL OR length(${t.employerCity}) <= 80`),
    check("we_state_len_chk", sql`${t.employerState} IS NULL OR length(${t.employerState}) <= 80`),
    check(
      "we_ym_format_chk",
      sql`(${t.startYm} IS NULL OR ${t.startYm} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$') AND (${t.endYm} IS NULL OR ${t.endYm} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')`,
    ),
    check(
      "we_ym_order_chk",
      sql`${t.startYm} IS NULL OR ${t.endYm} IS NULL OR ${t.endYm} >= ${t.startYm}`,
    ),
    check("we_duration_stated_chk", sql`${t.durationStated} = false OR ${t.startYm} IS NOT NULL`),
    check("we_sort_order_chk", sql`${t.sortOrder} >= 0`),
    // The only read this table has is "one worker's history, in display order".
    uniqueIndex("we_worker_sort_uq").on(t.workerId, t.sortOrder),
  ],
);

/** One role stint inside an employment. Its dates are its OWN, never the employer's (§11 #14). */
export const workerEmploymentRole = pgTable(
  "worker_employment_role",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employmentId: uuid("employment_id")
      .notNull()
      .references(() => workerEmployment.id, { onDelete: "cascade" }),
    roleLabel: text("role_label").notNull(),
    startYm: text("start_ym"),
    endYm: text("end_ym"),
    /** "CNC turning, Fanuc · EN8, EN31 · automotive components". The worker's own description. */
    workDone: text("work_done"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check("wer_role_label_chk", sql`length(btrim(${t.roleLabel})) BETWEEN 1 AND 80`),
    check("wer_work_done_len_chk", sql`${t.workDone} IS NULL OR length(${t.workDone}) <= 300`),
    check(
      "wer_ym_format_chk",
      sql`(${t.startYm} IS NULL OR ${t.startYm} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$') AND (${t.endYm} IS NULL OR ${t.endYm} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')`,
    ),
    check(
      "wer_ym_order_chk",
      sql`${t.startYm} IS NULL OR ${t.endYm} IS NULL OR ${t.endYm} >= ${t.startYm}`,
    ),
    check("wer_sort_order_chk", sql`${t.sortOrder} >= 0`),
    uniqueIndex("wer_employment_sort_uq").on(t.employmentId, t.sortOrder),
  ],
);

export const workerEmploymentRelations = relations(workerEmployment, ({ one, many }) => ({
  worker: one(workers, { fields: [workerEmployment.workerId], references: [workers.id] }),
  roles: many(workerEmploymentRole),
}));

export const workerEmploymentRoleRelations = relations(workerEmploymentRole, ({ one }) => ({
  employment: one(workerEmployment, {
    fields: [workerEmploymentRole.employmentId],
    references: [workerEmployment.id],
  }),
}));
