import { check, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import type { ApplicantPostingKind, ApplicantStage } from "@badabhai/types";

import { workers } from "./worker";

// ===========================================================================
// payer_applicant_stages — where an applicant sits on a posting's pipeline board (migration 0134)
// ===========================================================================
//
// Owner ruling 2026-10-07: payer-web's New / Shortlist / Passed board is SAVED SERVER-SIDE, so it
// survives a reload and every session that owns the posting sees the same board — today the
// posting's own payer; the whole org once PAY-DB-01 (ADR-0053) widens ownership. Until now it was
// local React state.
//
// ONE ROW PER (posting kind, posting id, worker) — the composite primary key, which is also the
// upsert target and the index every read uses:
//   - the per-posting feed reads one posting's rows   (PK prefix: posting_kind, posting_id),
//   - the inbox probes one row per listed application (the whole PK),
//   - the inbox stage filter is a predicate on that probed row (no index of its own: the inbox
//     is driven from the payer's own postings, so its cost already grows with ONE payer's
//     applications, never with this table).
//
// NO ROW MEANS `new`. A row moved back to New stores `new` explicitly rather than being deleted:
// one write path (lock, insert-or-update, event) instead of a delete/insert pair two teammates
// could race, and the row keeps who moved it back and when. Every reader treats "no row" and
// "`new`" identically (`COALESCE(stage, 'new')`).
//
// `posting_id` HAS NO FOREIGN KEY, deliberately: it names a `jobs` row or a `job_postings` row by
// `posting_kind`, and one column cannot reference two tables. Nothing in the product hard-deletes
// a posting (closed is terminal), and every read joins FROM an owned posting, so a row whose
// posting were ever removed (an ops seed/unseed script) is unreachable rather than wrong.
//
// NO TENANT COLUMN, BY ADR-0053 §4 (class C, "via parent"): the table carries no `payer_id`. ACCESS
// IS POSTING OWNERSHIP, decided by the API through the posting-ownership chokepoint
// (`findOwnedJobRef`) — the same check the feeds use — so when org tenancy (PAY-DB-01) moves that
// chokepoint to the org's tenant key, the board becomes the org's with no change here.
//
// `actor_payer_id` records WHO last moved the row: the acting login (ADR-0053 §3.1 — an actor is
// never a second `payer_id`). It is never an access rule. No foreign key — the faceless-rails
// convention of every payer reference on a posting (`jobs.payer_id`, `job_postings.payer_id`).
//
// NOT PII: two opaque ids, a closed kind, a closed stage, a payer id, timestamps. Erasure is the
// `worker_id` cascade.
//
// ADDITIVE. Rollback: the ordered procedure in migration 0134's header (flag off and redeploy
// FIRST — the API reads the flag at boot — then drop the table and its ledger row in one locked
// transaction).
// ===========================================================================
export const payerApplicantStages = pgTable(
  "payer_applicant_stages",
  {
    /** `company_posting` (a `job_postings` row) or `agency_job` (a legacy `jobs` row). */
    postingKind: text("posting_kind").$type<ApplicantPostingKind>().notNull(),
    /** The posting's id in the table `posting_kind` names. No FK (see the header). */
    postingId: uuid("posting_id").notNull(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    /** One of `APPLICANT_STAGES`. `new` is stored only for a row moved back to New. */
    stage: text("stage").$type<ApplicantStage>().notNull(),
    /** The acting login who made the CURRENT stage (ADR-0053 §3.1). No FK; never an access rule. */
    actorPayerId: uuid("actor_payer_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** When the CURRENT stage was set (stamped on every real change, never on a no-op). */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.postingKind, t.postingId, t.workerId],
      name: "payer_applicant_stages_pkey",
    }),
    // Backs the `worker_id` ON DELETE CASCADE: without it every worker erasure scans the table.
    index("payer_applicant_stages_worker_id_idx").on(t.workerId),
    // `APPLICANT_POSTING_KINDS` / `APPLICANT_STAGES` in @badabhai/types, spelled out because a
    // CHECK is static SQL. A new value widens these in its own migration, with a new event version.
    check(
      "payer_applicant_stages_posting_kind_chk",
      sql`${t.postingKind} IN ('company_posting', 'agency_job')`,
    ),
    check("payer_applicant_stages_stage_chk", sql`${t.stage} IN ('new', 'shortlist', 'passed')`),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0134

export type PayerApplicantStage = typeof payerApplicantStages.$inferSelect;
export type NewPayerApplicantStage = typeof payerApplicantStages.$inferInsert;
