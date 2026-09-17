import { relations, sql } from "drizzle-orm";
import {
  check,
  date,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { workers } from "./worker";

/**
 * The AES-256-GCM token shape `encryptPii` produces — the `workers.whatsapp_enc` pattern, applied
 * to a licence number so the column cannot hold prose (a 23514, not a code-review question).
 */
const ENC_TOKEN_SQL_PATTERN =
  "^(v1\\.[A-Za-z0-9+/=]+\\.[A-Za-z0-9+/=]+\\.[A-Za-z0-9+/=]+" +
  "|v2\\.[A-Za-z0-9_-]{1,32}\\.[A-Za-z0-9+/=]+\\.[A-Za-z0-9+/=]+\\.[A-Za-z0-9+/=]+)$";

/**
 * QUALIFICATIONS (migration 0098) — the credentials a worker holds, and who issued them.
 *
 * ═══ WHY THE EXISTING SHAPE CANNOT CARRY THIS ═══
 *
 * Zone 5 of the ratified sheet prints two rows the worker has no way to fill:
 *
 *   Education     ITI — Machinist · NCVT · 2018 · Govt. ITI, Faridabad
 *   Certificates  CNC Turning & Fanuc Programming (RVM CAD, Faridabad, 2020)
 *
 * EDUCATION is captured today, as four scalar keys on `worker_attributes` —
 * `education_credential`, `education_council`, `education_year`, `education_institute`. That
 * table is keyed `(worker_id, attribute_key)`, so it holds EXACTLY ONE of each. A worker with an
 * ITI and a later diploma has to overwrite one with the other, and `buildQualificationRows`
 * already takes `education` as a LIST — the renderer has been able to print several all along and
 * the capture surface could only ever supply one.
 *
 * CERTIFICATES are not captured at all, by any surface. The row prints from `draft.certifications`,
 * which only the LLM extraction path writes — and the trade-form handover deliberately switches
 * extraction off. So for every form-first worker the Certificates row has no source and never
 * appears, while `resume-degradation.ts` carries a ladder step to drop a row that cannot exist.
 * Both reference resumes for RVM's own students lead with a certificate.
 *
 * ═══ TWO TABLES, NOT ONE `worker_qualification` WITH A `kind` COLUMN ═══
 *
 * They share a shape and not a meaning. An education has a council and a field of study; a
 * certificate has neither and is not awarded by a board. Merging them would make four columns
 * nullable-by-kind and put the real constraint ("a council belongs to an education") somewhere no
 * CHECK can see it. They are also read separately — the sheet prints them as two rows, in two
 * places, under different degradation-ladder steps.
 *
 * ═══ ADDITIVE. NOTHING EXISTING IS TOUCHED ═══
 *
 * Two NEW, EMPTY tables. No column is added, dropped, renamed or re-typed on any shipped table,
 * no constraint is relaxed, no policy changed. The four `education_*` attribute keys keep being
 * written and keep being read; this table is a SECOND source that wins per-field where it has a
 * value, exactly as `tradeSheet.qualification` already wins over the draft snapshot. Rollback is
 * two DROP TABLEs and the database is byte-identical to 0097.
 *
 * ═══ THE INSTITUTE AND THE ISSUER ARE STORED IN CLEAR — A DECISION, NOT AN OVERSIGHT ═══
 *
 * `worker_employment.employer_name_enc` is AES-256-GCM ciphertext because "Ramesh worked at
 * Sandhar from Jan 2023" is an employment record, and that is personal data under DPDP even
 * though the company name alone is not.
 *
 * These columns follow the OTHER precedent — `education_institute`, which has shipped in clear on
 * `worker_attributes` since R9 §3 — because they are the same field in the same zone of the same
 * page, and moving one of them behind encryption while its sibling stays in clear would be an
 * inconsistency no reader could resolve. A credential attribution is also not a tenure: "trained
 * at RVM CAD" says nothing about where or whether the worker was employed.
 *
 * THE UNCOMFORTABLE CASE IS REAL AND IS NAMED HERE: an issuer CAN be an employer. Ramesh's own
 * sheet carries "Fire & Safety Awareness (Sandhar Technologies Ltd, 2023)", which discloses an
 * employer through the certificate row. That is a worker-entered value on a document the worker
 * hands out, and the same name already prints from `worker_employment` two rows above — but it is
 * the argument for encrypting these, and it is the security gate's to rule on, not this file's.
 * Encrypting later needs a backfill; that cost is accepted deliberately over shipping a zone
 * whose two halves disagree about their own threat model.
 *
 * NEITHER TABLE CROSSES THE AI BOUNDARY. Both are rendered deterministically by
 * `buildQualificationRows`, exactly as employer names are. `pseudonymize.py` is untouched.
 */

/**
 * A course, licence or trade certificate the worker holds.
 *
 * NOT A CLOSED VOCABULARY, and it cannot be one. The reference sheets carry "Mastercam Advanced
 * Multiaxis", "Welder Qualification Test — 3G, MS plate", "Internal Auditor — IATF 16949" and
 * "Wireman / Electrician Licence" — issued by training centres, OEMs, certification bodies and a
 * state licensing board respectively. There is no register to validate against, and inventing a
 * closed set would silently drop every certificate not on it. The role pack supplies a SUGGESTED
 * list per trade for the search box; this column stores whatever the worker settles on.
 */
export const workerCertificates = pgTable(
  "worker_certificate",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    /** What the certificate is called, as the worker reads it off the paper. */
    name: text("name").notNull(),
    /** Who awarded it — a training centre, an OEM, a certification body, an employer. */
    issuer: text("issuer"),
    /**
     * The year it was awarded.
     *
     * BOUNDED ON THE SAME RANGE `education_year` already uses. A year in the future or before
     * living memory is a typo, and a typo printed beside a real credential does more damage than
     * a missing segment.
     */
    year: integer("year"),
    /**
     * Display order.
     *
     * EXPLICIT, NOT DERIVED FROM `year`. Two certificates can share a year, an undated one still
     * has the place the worker gave it, and sorting by year would reshuffle rows between renders —
     * making every regenerated PDF a false diff.
     */
    sortOrder: integer("sort_order").notNull().default(0),
    /**
     * ADR-0042 D9 / Layer A (d) — a licence number, AES-256-GCM CIPHERTEXT (`encryptPii` token).
     *
     * NEVER PUBLIC, NEVER EMPLOYER-VISIBLE. It exists for the worker's OWN record (and for any
     * future verification flow, which would be its own ruled change). Unlike `name`/`issuer`/`year`
     * — which print on the sheet — this column is read by the worker-self GET only; the résumé
     * composition in `resume-qualification-rows.ts` never names it, so it cannot print even if a
     * caller passed it.
     */
    licenceNumberEnc: text("licence_number_enc"),
    /**
     * When the licence expires, as a DATE (day precision — no timezone arithmetic).
     *
     * NEVER PUBLIC, NEVER EMPLOYER-VISIBLE, same ruling as the number. `date` rather than
     * `timestamp`: an expiry is a calendar day the worker reads off the document, and a timestamp
     * would round-trip through UTC and shift under IST.
     */
    licenceExpiry: date("licence_expiry"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // A nameless certificate is a row that prints "(RVM CAD, 2020)" and nothing else.
    check("wc_name_chk", sql`length(btrim(${t.name})) BETWEEN 1 AND 120`),
    check("wc_issuer_len_chk", sql`${t.issuer} IS NULL OR length(${t.issuer}) <= 120`),
    check("wc_year_chk", sql`${t.year} IS NULL OR (${t.year} BETWEEN 1950 AND 2100)`),
    check("wc_sort_order_chk", sql`${t.sortOrder} >= 0`),
    // Layer A (d): the number is ciphertext at rest, enforced here rather than trusted.
    check(
      "wc_licence_number_enc_token_chk",
      sql`${t.licenceNumberEnc} IS NULL OR ${t.licenceNumberEnc} ~ ${sql.raw(`'${ENC_TOKEN_SQL_PATTERN}'`)}`,
    ),
    check(
      "wc_licence_expiry_chk",
      sql`${t.licenceExpiry} IS NULL OR ${t.licenceExpiry} >= DATE '1950-01-01'`,
    ),
    // The only read is "give me one worker's certificates, in display order".
    uniqueIndex("wc_worker_sort_uq").on(t.workerId, t.sortOrder),
  ],
).enableRLS();

/**
 * One schooling or trade credential.
 *
 * THE FIVE SEGMENTS THE SHEET PRINTS, each its own column rather than one composed string:
 * "ITI — Machinist · NCVT · 2018 · Govt. ITI, Faridabad". Storing the rendered line would make
 * the composition unfixable and the parts unmatchable — `education_level` and `education_field`
 * are matching inputs, not decoration.
 */
export const workerEducations = pgTable(
  "worker_education",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    /**
     * ITI, Diploma, 10th, 12th, below-10th, Graduate — the closed set `EDUCATION_QUALIFICATIONS`
     * offers (six values), which is what `worker-qualifications.dto.ts` validates against and
     * what `resume-qualification-rows.ts` labels from.
     *
     * NOT `EDUCATION_CREDENTIALS` — this line used to say so and it is the likeliest source of
     * the #1447 misreading that the two dictionaries are duplicates. That one holds exactly TWO
     * values and answers a narrower question: "the interview's merged `iti_diploma` option names
     * two credentials, which is yours". This column holds a whole credential standing on its own.
     */
    credential: text("credential"),
    /** The trade or stream: "Machinist", "Fitter", "Mechanical Engineering", "Science". */
    field: text("field"),
    /**
     * NCVT, SCVT, a state board.
     *
     * KEPT APART FROM `credential` BECAUSE THE DISTINCTION IS THE POINT. NCVT is the national
     * certificate and SCVT the state one, and they are not interchangeable for a job that
     * requires a specific trade certificate. Printing "ITI" alone throws that away.
     */
    council: text("council"),
    year: integer("year"),
    /**
     * The institute, as the worker reads it off the certificate.
     *
     * FREE TEXT, because there is no national register of ITI names to validate against and
     * inventing a closed set would silently drop every institute not on it.
     */
    institute: text("institute"),
    /** Display order — highest or most relevant first, and the worker's own ordering. */
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    /**
     * A row must say SOMETHING. Every column here is individually optional — a worker may know
     * their trade and not their council, or their institute and not their year — but a row with
     * all five null is a blank line on the sheet, and the renderer would have to guess whether
     * to drop it. The database refuses to store one instead.
     */
    check(
      "wed_not_empty_chk",
      sql`${t.credential} IS NOT NULL OR ${t.field} IS NOT NULL OR ${t.council} IS NOT NULL OR ${t.year} IS NOT NULL OR ${t.institute} IS NOT NULL`,
    ),
    check("wed_credential_len_chk", sql`${t.credential} IS NULL OR length(${t.credential}) <= 40`),
    check("wed_field_len_chk", sql`${t.field} IS NULL OR length(${t.field}) <= 80`),
    check("wed_council_len_chk", sql`${t.council} IS NULL OR length(${t.council}) <= 40`),
    check("wed_year_chk", sql`${t.year} IS NULL OR (${t.year} BETWEEN 1950 AND 2100)`),
    check("wed_institute_len_chk", sql`${t.institute} IS NULL OR length(${t.institute}) <= 120`),
    check("wed_sort_order_chk", sql`${t.sortOrder} >= 0`),
    uniqueIndex("wed_worker_sort_uq").on(t.workerId, t.sortOrder),
  ],
).enableRLS();

/**
 * A course or training programme the worker attended (ADR-0042 D9 / Layer A (d), migration 0112).
 *
 * ═══ WHY THIS IS NOT A `worker_certificate` ROW ═══
 *
 * A certificate is an AWARD; a training is an ATTENDANCE. The reference sheets carry both —
 * "CNC Turning & Fanuc Programming (RVM CAD, 2020)" is a certificate, while "3-month CNC operator
 * course, Govt. ITI, 2019" is training with a provider and a year but often no document at all.
 * Folding them together would force a `kind` column and put the real difference ("does this have
 * an issuer and a licence number?") somewhere no CHECK can see it — the identical argument that
 * kept `worker_certificate` and `worker_education` apart in 0098.
 *
 * ═══ PII-FREE BY CONSTRUCTION ═══
 *
 * Name, provider and year only; nothing here is identity, and the whole row prints (through the
 * deterministic composition in `resume-qualification-rows.ts`) as a training line. No licence
 * numbers live here — those belong to the certificate that carries them, encrypted.
 */
export const workerTrainings = pgTable(
  "worker_training",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    /** What the course was called, as the worker reads it off the completion slip. */
    name: text("name").notNull(),
    /** Who ran it — a training centre, an OEM, a government ITI, an employer. */
    provider: text("provider"),
    /** The year it finished. Bounded like `wc_year_chk`, for the same typo argument. */
    year: integer("year"),
    /** Display order — the worker's own ordering, never derived (see `wc_sort_order_chk`). */
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check("wt_name_chk", sql`length(btrim(${t.name})) BETWEEN 1 AND 120`),
    check("wt_provider_len_chk", sql`${t.provider} IS NULL OR length(${t.provider}) <= 120`),
    check("wt_year_chk", sql`${t.year} IS NULL OR (${t.year} BETWEEN 1950 AND 2100)`),
    check("wt_sort_order_chk", sql`${t.sortOrder} >= 0`),
    uniqueIndex("wt_worker_sort_uq").on(t.workerId, t.sortOrder),
  ],
).enableRLS();

export const workerCertificatesRelations = relations(workerCertificates, ({ one }) => ({
  worker: one(workers, {
    fields: [workerCertificates.workerId],
    references: [workers.id],
  }),
}));

export const workerEducationsRelations = relations(workerEducations, ({ one }) => ({
  worker: one(workers, {
    fields: [workerEducations.workerId],
    references: [workers.id],
  }),
}));

export const workerTrainingsRelations = relations(workerTrainings, ({ one }) => ({
  worker: one(workers, {
    fields: [workerTrainings.workerId],
    references: [workers.id],
  }),
}));

export type WorkerCertificate = typeof workerCertificates.$inferSelect;
export type NewWorkerCertificate = typeof workerCertificates.$inferInsert;
export type WorkerEducation = typeof workerEducations.$inferSelect;
export type NewWorkerEducation = typeof workerEducations.$inferInsert;
export type WorkerTraining = typeof workerTrainings.$inferSelect;
export type NewWorkerTraining = typeof workerTrainings.$inferInsert;
