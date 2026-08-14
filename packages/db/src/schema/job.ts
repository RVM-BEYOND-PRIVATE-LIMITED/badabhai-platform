/**
 * Job domain — ops-created job postings (ADR-0012), the faceless `jobs` feed rows,
 * and the apply/skip `applications` record.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  smallint,
  timestamp,
  date,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import type {
  VacancyBand,
  JobPostingStatus,
  JobPostingVerificationStatus,
} from "@badabhai/types";
import type { TradeKey, SkipReason, SourceSurface } from "@badabhai/taxonomy";
import { jsonArray } from "./internal/sql-defaults";
import { workers } from "./worker";

// Re-export TradeKey for downstream consumers (seed files, etc.)
export type { TradeKey, SkipReason, SourceSurface } from "@badabhai/taxonomy";

// ---------------------------------------------------------------------------
// job_postings (ADR-0012) — ops-created, vacancy-banded, stored-only postings.
//
// Phase 1 scope: this is a STORED-ONLY record an ops actor creates. It does NOT
// feed ranking/matching (Reach Engine is deferred) and has NO worker linkage.
//
// PRIVACY: org_label / role_title / location_label / description are NON-PII
// free text by contract — ops must not type a worker's phone/name/etc. into
// them. That boundary is enforced in the API/event layer; the table just stores
// the strings. `created_by` is an OPAQUE ops-actor id (no FK to anything).
// `id` is the subject_id for all job_posting.* events.
//
// `vacancy_band` is BANDED text (not an integer count) on purpose — distinct
// from any vacancy_count column. CHECK constraints pin both unions at the DB
// (mirrors VACANCY_BANDS / JOB_POSTING_STATUSES in @badabhai/types).
// ---------------------------------------------------------------------------
export const jobPostings = pgTable(
  "job_postings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Opaque ops-actor id — deliberately NO foreign key to any table.
    createdBy: uuid("created_by").notNull(),
    // Opaque OWNER payer ref (ADR-0019/ADR-0022 module 9 — payer self-serve posting).
    // NULLABLE + NO foreign key (the "faceless-rails" pattern, mirroring jobs.payer_id):
    // ops-created postings leave it NULL (the existing surface is unchanged); a payer-
    // created posting stamps the SESSION payer here, and the payer routes scope every
    // read/write by it (tenancy). Never enters an event payload — the event ACTOR
    // (actor_type:"payer", actor_id) carries the payer id, opaque, instead.
    payerId: uuid("payer_id"),
    orgLabel: text("org_label").notNull(),
    roleTitle: text("role_title").notNull(),
    // ADR-0030 / TAX-6 — the JOB side of the shared skill id space (ADDITIVE, SG-5).
    // `skill_phrases` = what the poster typed (free text, non-matchable, like
    // `description`); `skill_ids` = ONLY vector-layer-assigned closed-set ids from the
    // SAME canonicalize_skill pipeline the worker side uses (SG-3 — never free text,
    // never invented). Both default '[]' so every existing row/reader is untouched.
    // NOT a RANK input (invariant #4): the reach path never reads these — the
    // reach-engine guard test locks that. Rollback = flag off (ids stop being stored).
    skillPhrases: jsonb("skill_phrases").$type<string[]>().notNull().default(jsonArray),
    skillIds: jsonb("skill_ids").$type<string[]>().notNull().default(jsonArray),
    locationLabel: text("location_label"),
    description: text("description"),
    vacancyBand: text("vacancy_band").$type<VacancyBand>().notNull(),
    status: text("status").$type<JobPostingStatus>().notNull().default("draft"),
    // Ops trust review → the worker-visible "Verified job" badge. ADDITIVE, safe:
    // every existing row defaults to 'unverified' (no behaviour change). Only an
    // ops verify/reject action moves it; the payer/worker read exposes only the
    // boolean `verified` (status === 'verified'). NOT a RANK input (invariant #4).
    // Rollback = drop column (nothing reads it fails-closed to unverified).
    verificationStatus: text("verification_status")
      .$type<JobPostingVerificationStatus>()
      .notNull()
      .default("unverified"),
    // ── Matching V1 (migration 0054): job_postings becomes THE SERVED job entity ──
    // Owner ruling (CEO ratification 2026-07-30): the worker feed serves `job_postings`;
    // the legacy `jobs` table retires from the worker path. These columns are the fields
    // `jobs` carried that `job_postings` did not. ALL NULLABLE / DEFAULTED and purely
    // additive — every shipped ops/payer read is untouched, and a posting created before
    // this migration simply has no match ids (it reaches nobody, it does not crash).
    // `jobs` itself is NOT dropped, NOT renamed and NOT modified (invariant #8): the
    // D4 converter COPIES open rows across and closes the originals, and existing
    // `applications.job_id` rows keep pointing at them forever.
    //
    // PRIVACY: same contract as the columns above — `city` is a COARSE city bucket
    // (never an address), pay is an integer ₹ band, `shift`/`needed_by` are coarse
    // enums. No employer identity, ever.
    // Industry scope (`ind_*`). Matching never crosses industries. Nullable: a legacy
    // posting has none until an ops/payer edit or D3 sets it.
    industryId: text("industry_id"),
    // The 1..N (config `max_skills_per_posting`, 3 at launch) `mskill_*` ids the poster
    // actually asked for. TIER 1 = a worker holding one of these.
    matchSkillIds: jsonb("match_skill_ids").$type<string[]>().notNull().default(jsonArray),
    // match_skill_ids ∪ their `skill_related` neighbours — the full set a worker can be
    // reached through. TIER 2 = matched via a related skill only. DENORMALIZED on write
    // so the per-worker reconciliation is one GIN probe (`reach_skill_ids ?| $workerSkills`)
    // instead of a recursive join. Recomputed whenever match_skill_ids changes.
    // DELIBERATELY NOT the same thing as the ADR-0030 `skill_ids` column above: that one
    // is the vector-canonicalizer's descriptive tagging and is explicitly NOT a rank
    // input; these two are the V1 MATCH inputs and are deterministic (invariant #4).
    reachSkillIds: jsonb("reach_skill_ids").$type<string[]>().notNull().default(jsonArray),
    // COARSE city bucket (e.g. "Pune") — mirrors `jobs.city`. NEVER an address.
    // `location_label` above stays as-is (free text); `city` is the matchable field.
    city: text("city"),
    // COARSE state bucket (e.g. "Maharashtra") — the second location filter `GET /jobs/search`
    // offers (#822). NEVER an address, and deliberately NOT parsed out of `location_label`:
    // that column is poster free text and could hold anything, so deriving a matchable field
    // from it would put unvalidated data where a filter trusts it.
    //
    // NULLABLE WITH NO BACKFILL, and that is the whole backward-compatibility argument
    // (§10 additive). Every existing row reads NULL, which the search filter treats as "does
    // not match a state query" rather than as a hidden default — so no posting silently
    // changes which searches it answers. A row gains a state only when a poster supplies one.
    state: text("state"),
    // Monthly pay band offered (INR, whole rupees — never paise). Mirrors `jobs`.
    payMin: integer("pay_min"),
    payMax: integer("pay_max"),
    // Coarse shift enum (mirrors jobs.shift). Non-PII.
    shift: text("shift").$type<JobShift>(),
    // When the job needs someone (mirrors jobs.needed_by). Non-PII.
    neededBy: text("needed_by").$type<JobNeededBy>(),
    // When the posting became worker-visible. The feed orders by this, NOT by
    // created_at, so a draft that sat for a week does not surface as a week-old job.
    // NULL = never published. D3 backfills it to created_at for non-draft rows.
    publishedAt: timestamp("published_at", { withTimezone: true }),
    // Boost window end (ADR-0013 economics, re-expressed on the served entity). NULL =
    // not boosted. A time, not a flag, so a boost expires without a sweep.
    boostedUntil: timestamp("boosted_until", { withTimezone: true }),
    // CUTOVER PROVENANCE (D4 idempotency). Set ONLY by `db:convert:seed-jobs` to the
    // `jobs.id` this posting was converted from; NULL for every natively-created posting.
    // The UNIQUE index below is what makes the converter a true no-op on re-run — a
    // second attempt to convert the same legacy job conflicts instead of duplicating it.
    // ON DELETE SET NULL: deleting a legacy job must never delete the live posting.
    sourceJobId: uuid("source_job_id").references(() => jobs.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    // ADR-0037 — the live status this posting held before the owning payer was suspended,
    // so reinstatement restores it EXACTLY (`open` stays open, `paused` stays paused)
    // instead of guessing. Written only by the suspension cascade and cleared by the
    // reinstatement cascade; NULL at every other moment, so a non-NULL value on a row that
    // is not `suspended` is a bug, not a state.
    //
    // Reinstating to a hardcoded `open` would silently RESUME a posting the payer had
    // deliberately paused — publishing a job they took down, which is the one outcome a
    // suspension must not cause.
    previousStatus: text("previous_status").$type<JobPostingStatus>(),
  },
  (t) => [
    // Backs the ops list endpoint: filter by `status`, order by `created_at desc`.
    index("job_postings_status_created_at_idx").on(t.status, t.createdAt),
    // ADR-0037 — backs the suspend/reinstate cascade, which is `WHERE payer_id = $1 AND
    // status IN (...)`. `job_postings_payer_id_idx` below leads on payer_id but its second
    // column is created_at, so the status predicate is a filter, not a seek. A payer with
    // many postings is exactly the case where the cascade matters most.
    index("job_postings_payer_id_status_idx").on(t.payerId, t.status),
    // Backs the payer self-serve list (own postings, newest first): WHERE payer_id, status.
    index("job_postings_payer_id_idx").on(t.payerId, t.createdAt),
    // ── Matching V1 feed + reconciliation indexes ─────────────────────────────
    // THE FEED: WHERE status='open' ORDER BY published_at DESC. DESC in the index so the
    // scan is forward (no backward walk, no sort node).
    index("job_postings_feed_idx").on(t.status, t.publishedAt.desc()),
    // THE PER-WORKER RECONCILIATION: `reach_skill_ids ?| $workerSkillIds` — "which open
    // postings can reach this worker?" — the query that repairs a worker whose skills
    // changed after a posting was materialized. jsonb_path_ops (not the default
    // jsonb_ops) because we only ever ask containment/existence questions: it is ~3x
    // smaller and faster for exactly that, at the cost of key-only lookups we never do.
    index("job_postings_reach_gin").using("gin", t.reachSkillIds.op("jsonb_path_ops")),
    // D4 idempotency: one posting per converted legacy job. NULLs are DISTINCT in
    // Postgres, so the thousands of natively-created postings never collide.
    uniqueIndex("job_postings_source_job_id_uq").on(t.sourceJobId),
    // Pin the banded vacancy to the 5 allowed values (mirrors VACANCY_BANDS).
    check(
      "job_postings_vacancy_band_chk",
      sql`${t.vacancyBand} IN ('1', '2-5', '6-10', '11-25', '25+')`,
    ),
    // Pin the lifecycle to the 5 allowed values (mirrors JOB_POSTING_STATUSES). `paused`
    // (B1) is a reversible open<->paused state, additive to the original draft/open/closed;
    // `suspended` (ADR-0037) is the system state the payer-suspension cascade writes.
    check(
      "job_postings_status_chk",
      sql`${t.status} IN ('draft', 'open', 'paused', 'suspended', 'closed')`,
    ),
    // ADR-0037 — `previous_status` describes a SUSPENSION and nothing else. Non-suspended
    // rows must carry NULL, so a stale value can never be restored onto a posting that was
    // legitimately closed or republished while the column was still set. Enforced in the DB
    // because both the suspend and reinstate writes are one-statement cascades: there is no
    // application-layer read to check it against.
    check(
      "job_postings_previous_status_chk",
      sql`(${t.status} = 'suspended') OR (${t.previousStatus} IS NULL)`,
    ),
    // Pin the trust review to the 3 allowed values (mirrors JOB_POSTING_VERIFICATION_STATUSES).
    check(
      "job_postings_verification_status_chk",
      sql`${t.verificationStatus} IN ('unverified', 'verified', 'rejected')`,
    ),
    // ── Matching V1 (0054): the pay/shift/timing sanity checks `jobs` already has ──
    // Mirrored verbatim so the served entity cannot hold data the retiring entity
    // would have rejected. All are NULL-tolerant (every column is nullable).
    check(
      "job_postings_pay_nonneg_chk",
      sql`(${t.payMin} IS NULL OR ${t.payMin} >= 0) AND (${t.payMax} IS NULL OR ${t.payMax} >= 0)`,
    ),
    check(
      "job_postings_pay_order_chk",
      sql`${t.payMin} IS NULL OR ${t.payMax} IS NULL OR ${t.payMax} >= ${t.payMin}`,
    ),
    check(
      "job_postings_shift_chk",
      sql`${t.shift} IS NULL OR ${t.shift} IN ('day', 'night', 'rotational')`,
    ),
    check(
      "job_postings_needed_by_chk",
      sql`${t.neededBy} IS NULL OR ${t.neededBy} IN ('immediate', 'soon', 'flexible')`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)

// Alpha swipe-to-apply (ADR-0009) — seeded jobs + apply/skip records.
//
// A scoped early activation that sits beside Phase 1: a worker sees a small set
// of seeded jobs and applies or skips, producing the PII-free `feed.shown` /
// `application.submitted` / `application.skipped` events defined in ADR-0006.
// Strictly additive, backward-compatible (CLAUDE.md §2 invariant 8).
//
// PRIVACY (ADR-0009 §2): both tables are PII-free. `jobs` carries ZERO PII — no
// employer name/id, no contact/phone, no exact address/geo, no pay/salary (those
// are deferred Phase-2 economics, ADR-0009 §6). The ONLY join back to identity is
// `applications.worker_id` → `workers` (where PII already lives, RLS-locked). This
// creates no new PII surface.
// ---------------------------------------------------------------------------

/**
 * The 15+9 canonical trade keys (15 manufacturing alpha + 9 hospitality DRAFT).
 *
 * Now imported from @badabhai/taxonomy (TD31) — single source of truth.
 * The comment below documents the historical mirroring for audit purposes.
 *
 * MANUFACTURING (15, alpha; ADR-0009 §2 / OQ-2):
 *   cnc_operator, vmc_operator, cnc_vmc_setter, cnc_programmer, vmc_programmer,
 *   cad_designer, solidworks_designer, autocad_draftsman, quality_inspector,
 *   production_engineer, maintenance_technician, tool_room_technician,
 *   machine_operator, assembly_technician, fitter
 *
 * HOSPITALITY (9, second vertical; DRAFTED, pending RVM — NOT live):
 *   hosp_steward_waiter, hosp_commis_cook, hosp_room_attendant, hosp_front_office,
 *   hosp_fnb_captain, hosp_bartender, hosp_kitchen_steward, hosp_banquet_server,
 *   hosp_barista
 *
 * TD31 (shared taxonomy package) now provides the authoritative TradeKey type.
 * Keep this comment for historical context; the actual type is imported.
 */

/**
 * Job lifecycle — a seed job can be retired without deleting the row.
 *
 * `suspended` (ADR-0037) is the SYSTEM state written when the owning payer is suspended,
 * and cleared when they are reinstated. It exists so the cascade does not have to overload
 * `closed`, which is what an agency's own "pause" already maps to (pause == close on this
 * table) and which a reinstatement must NOT reopen — closing is the payer's decision and
 * survives a suspension.
 *
 * Unlike `job_postings` this table carries NO `previous_status`: it has exactly ONE live
 * state, so a reinstatement restores `suspended -> open` deterministically and there is
 * nothing to remember. If a third live state is ever added here, that stops being true and
 * this table needs the column too.
 */
export type JobStatus = "open" | "closed" | "suspended";

/**
 * When the job needs someone — the demand-side availability signal the Reach RANK
 * core's `neededBy` consumes (ADR-0011; mirrors JobSpec.neededBy). Non-PII.
 */
export type JobNeededBy = "immediate" | "soon" | "flexible";

/**
 * Work-shift enum for the worker-visible job card (ADR-0024 addendum 2026-07-16).
 * Coarse, non-PII — never an employer identity signal.
 */
export type JobShift = "day" | "night" | "rotational";

/** Apply/skip decision. Mirrors the `applications` event family. */
export type ApplicationAction = "applied" | "skipped";

/**
 * Coarse, non-PII skip reason (no free text). Mirrors the `application.skipped`
 * event payload enum in @badabhai/event-schema (payloads.ts). NULL for applies.
 *
 * Now imported from @badabhai/taxonomy (TD31) — single source of truth.
 */

/**
 * Where the apply/skip originated. Mirrors the `application.submitted` event
 * payload `source_surface` enum in @badabhai/event-schema (payloads.ts).
 *
 * Now imported from @badabhai/taxonomy (TD31) — single source of truth.
 */

// jobs — seeded, coarse, NO employer PII. `id` is the opaque job_id in events.
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // One of the 15 alpha trade keys (taxonomy linkage, ADR-0009 OQ-2). Not a PII
    // employer reference — a generic trade classification.
    tradeKey: text("trade_key").$type<TradeKey>().notNull(),
    // Generic role title authored in the seed (e.g. "CNC Operator — Night Shift").
    // NEVER an employer name (ADR-0009 §2 privacy line).
    title: text("title").notNull(),
    // COARSE location — city only, non-PII (e.g. "Pune"). Never an address.
    city: text("city").notNull(),
    // COARSE locality bucket (e.g. "Pimpri-Chinchwad"), NOT an address. Nullable.
    area: text("area"),
    status: text("status").$type<JobStatus>().notNull().default("open"),
    // ADR-0010 §Decision 0 (evolve-not-replace): the opaque "faceless-rails" SELLER
    // id — the payer (employer OR agent) who posted this job. ADDITIVE, NULLABLE, NO
    // FK, NO `payers` identity table, and NEVER an employer name or any employer PII.
    // It only ties a job to a billable payer for the unlock spine (ADR-0010 §D6);
    // PR #42 introduces the same column on its richer jobs entity — whichever lands
    // first owns it, the other consumes it. NEVER resolved to identity in any event
    // or log.
    payerId: uuid("payer_id"),
    // Denormalized on-row counter of applies received for this job (ADR-0009
    // swipe-to-apply). Each apply still emits its own `application.submitted` event;
    // this is just an integer rollup for the feed/UI. PII-FREE (a count, never a name).
    // Mirrors posting_plans.applicantsViewedCount style.
    applicantsReceived: integer("applicants_received").notNull().default(0),
    // ── Demand-side ranking signals (ADR-0011 Reach-on-real-jobs) ──────────────
    // Feed the RANK core's Pay/Experience/Availability factors when Reach serves
    // this job. ALL NULLABLE + additive (the engine neutral-defaults a null — a
    // blank never drops or penalizes anyone). PII-FREE: pay bands / year counts /
    // a coarse timing enum — never an employer or a worker identity. Role (trade_key)
    // and Distance (city) are already present above, so no column is needed for them.
    // Monthly pay band offered (INR, whole rupees — never paise).
    payMin: integer("pay_min"),
    payMax: integer("pay_max"),
    // Experience window the job targets (years).
    minExperienceYears: integer("min_experience_years"),
    maxExperienceYears: integer("max_experience_years"),
    // When the job needs someone (coarse enum).
    neededBy: text("needed_by").$type<JobNeededBy>(),
    // ── Worker-visible job content (ADR-0024 addendum 2026-07-16) ──────────────
    // Shown VERBATIM to workers on the job card/detail. ALL NULLABLE + additive.
    // These strings MUST NEVER contain employer identity or contact info — no
    // employer/company names, phone numbers, emails, addresses, or URLs (the
    // seeder fail-closed guards this; ADR-0009 §2 privacy line still applies).
    // Short role/work description (a few sentences). Never an employer name.
    description: text("description"),
    // Coarse shift enum for the job card (day/night/rotational). Non-PII.
    shift: text("shift").$type<JobShift>(),
    // Short PII-free benefit strings (e.g. "PF + ESI", "Canteen").
    benefits: jsonb("benefits").$type<string[]>(),
    // Short requirement tags (e.g. "Fanuc control", "ITI / Diploma"). PII-free.
    requirements: jsonb("requirements").$type<string[]>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Backs the worker feed + reach open-jobs queries: filter `status='open'`,
    // order by `created_at` (id tiebreak via the PK). Also serves the status filter.
    index("jobs_status_created_at_idx").on(t.status, t.createdAt),
    // Covers the feed filtering (TD66) to avoid unindexed scans on trade_key/city
    index("jobs_status_trade_city_created_at_idx").on(t.status, t.tradeKey, t.city, t.createdAt),
    // ADR-0037 — backs the payer-suspension cascade (`WHERE payer_id = $1 AND status = ...`).
    // `payer_id` had NO index at all: every agency-owned read and the cascade were seq scans.
    index("jobs_payer_id_status_idx").on(t.payerId, t.status),
    check("jobs_applicants_received_nonneg_chk", sql`${t.applicantsReceived} >= 0`),
    // Pay/experience are non-negative when present, and the max is not below the min.
    check(
      "jobs_pay_nonneg_chk",
      sql`(${t.payMin} IS NULL OR ${t.payMin} >= 0) AND (${t.payMax} IS NULL OR ${t.payMax} >= 0)`,
    ),
    check(
      "jobs_pay_order_chk",
      sql`${t.payMin} IS NULL OR ${t.payMax} IS NULL OR ${t.payMax} >= ${t.payMin}`,
    ),
    check(
      "jobs_experience_nonneg_chk",
      sql`(${t.minExperienceYears} IS NULL OR ${t.minExperienceYears} >= 0) AND (${t.maxExperienceYears} IS NULL OR ${t.maxExperienceYears} >= 0)`,
    ),
    check(
      "jobs_experience_order_chk",
      sql`${t.minExperienceYears} IS NULL OR ${t.maxExperienceYears} IS NULL OR ${t.maxExperienceYears} >= ${t.minExperienceYears}`,
    ),
    check(
      "jobs_needed_by_chk",
      sql`${t.neededBy} IS NULL OR ${t.neededBy} IN ('immediate', 'soon', 'flexible')`,
    ),
    check(
      "jobs_shift_chk",
      sql`${t.shift} IS NULL OR ${t.shift} IN ('day', 'night', 'rotational')`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)

// applications — the apply/skip record, PII-free. One decision per (worker, job).
//
// ── Matching V1 (migration 0056) — COEXIST, NEVER REPOINT ────────────────────
// The served entity moved from `jobs` to `job_postings`, so this table now carries TWO
// nullable job references and a CHECK that exactly one side is always present:
//   * `job_id`         — the LEGACY reference. Every alpha application keeps it. It is
//                        NEVER rewritten, NEVER backfilled, NEVER repointed.
//   * `job_posting_id` — the V1 reference. EVERY NEW decision writes this one.
// Repointing history would silently rewrite what a worker actually applied to; the ADR
// forbids it and so does invariant #8. The cost is one nullable column and one CHECK.
//
// `job_id` DROPPING NOT NULL is the one shipped-column change in the whole train. It is
// a RELAXATION (expand direction) — every existing row still satisfies it and every
// existing reader still sees a non-null value on every existing row. But see the
// migration header: once a single posting-only row exists, re-adding NOT NULL is no
// longer possible without deleting real applications. That is the one-way door.
//
// The SNAPSHOT columns (match_tier, skill_months, industry_months, last_worked_at,
// engine_version) are stamped AT DECISION TIME and never recomputed. They are the whole
// point of shipping this migration early: they are the doc's "only irreversible
// decision — history not captured on day one is gone permanently". A worker's skill
// months change; what they were when the payer ranked this applicant cannot be
// reconstructed later. `engine_version` makes an old row honestly readable under a
// future rank rule instead of silently re-interpreted under it.
//
// PRIVACY: still PII-FREE. The snapshot is integers, a date, a smallint and a version
// string — no name, phone, or employer.
export const applications = pgTable(
  "applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // LEGACY reference — nullable since 0056 (see the header note). Not deprecated:
    // it is the permanent, correct pointer for every pre-V1 application.
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "cascade" }),
    // V1 reference — the served entity. Every new decision writes this.
    jobPostingId: uuid("job_posting_id").references(() => jobPostings.id, {
      onDelete: "cascade",
    }),
    // The ONLY join back to identity; PII stays in `workers` (RLS-locked).
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    action: text("action").$type<ApplicationAction>().notNull(),
    // Populated ONLY when action='skipped' (enforced by the CHECK below); NULL for
    // applies. Coarse enum — no free text (PII-free).
    reason: text("reason").$type<SkipReason>(),
    sourceSurface: text("source_surface").$type<SourceSurface>().notNull().default("feed"),
    // The seed display position the action was taken from; nullable.
    rank: integer("rank"),
    // ── V1 RANK SNAPSHOT — stamped once, at decision time, never recomputed ──────
    // 1 = matched a skill the poster asked for · 2 = matched via a related skill.
    matchTier: smallint("match_tier"),
    // The worker's bucketed months on the skill that earned the tier, AS OF this apply.
    skillMonths: integer("skill_months"),
    // The worker's calendar months in the posting's industry, AS OF this apply.
    industryMonths: integer("industry_months"),
    // Recency input for the rank rule: when the worker last worked the matched skill.
    lastWorkedAt: date("last_worked_at"),
    // Which rank rule produced the numbers above (match_config.engine_version, "v1.0").
    // Without it, a v2 reader silently re-interprets v1 rows under v2 semantics.
    engineVersion: text("engine_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Idempotency / natural key: at most one decision per (worker, job). Makes
    // apply/skip a safe upsert — last-write-wins via ON CONFLICT (worker_id,
    // job_id) DO UPDATE (ADR-0009 §2). Also serves worker_id-leading ops lookups
    // ("decisions per worker"), so no separate worker_id index is needed.
    // Postgres NULLS DISTINCT means the new posting-only rows (job_id IS NULL) never
    // collide here, so this shipped constraint keeps working untouched.
    uniqueIndex("applications_worker_job_uq").on(t.workerId, t.jobId),
    // Ops read: applicants per job.
    index("applications_job_id_idx").on(t.jobId),
    // Partial index for feed exclusion (TD73): quickly find applied jobs per worker
    index("applications_applied_idx").on(t.workerId, t.jobId).where(sql`${t.action} = 'applied'`),
    // `reason` is only valid on a skip (NULL otherwise).
    check("applications_reason_chk", sql`${t.reason} IS NULL OR ${t.action} = 'skipped'`),
    // ── Matching V1 (0056) ────────────────────────────────────────────────────
    // E15: one application per (worker, posting). PARTIAL so it applies only to V1 rows
    // and leaves the millions of legacy job_posting_id-NULL rows entirely out of the
    // index (small) — and so it can never collide with the legacy unique above.
    uniqueIndex("applications_worker_posting_uq")
      .on(t.workerId, t.jobPostingId)
      .where(sql`${t.jobPostingId} IS NOT NULL`),
    // The V1 feed's applied-exclusion ("don't show me what I already applied to"), the
    // job_posting_id twin of applications_applied_idx above.
    index("applications_applied_posting_idx")
      .on(t.workerId, t.jobPostingId)
      .where(sql`${t.action} = 'applied' AND ${t.jobPostingId} IS NOT NULL`),
    // THE PAYER'S APPLICANT LIST, in rank order, straight out of the index — the exact
    // ORDER BY the rank rule specifies (tier, then skill months, then industry months,
    // then recency, then arrival, then id as the total-order tiebreak). Partial on
    // action='applied' because a skip is never ranked. `id` last makes the order TOTAL,
    // so keyset pagination cannot skip or repeat a row.
    index("applications_rank_idx")
      .on(
        t.jobPostingId,
        t.matchTier,
        t.skillMonths.desc(),
        t.industryMonths.desc(),
        t.lastWorkedAt.desc(),
        t.createdAt.desc(),
        t.id,
      )
      .where(sql`${t.action} = 'applied'`),
    // BP-1 — the admin applications keyset (see workers_admin_keyset_idx). The unfiltered
    // and worker/action-filtered admin lists all order by this; the posting-scoped read is
    // already served by applications_rank_idx / applications_job_id_idx.
    index("applications_admin_keyset_idx").on(t.createdAt.desc(), t.id.desc()),
    // Exactly one job reference must be present. This is what makes "coexist" a DB
    // guarantee instead of a convention: a row with neither pointer cannot be written.
    check(
      "applications_job_ref_chk",
      sql`(${t.jobId} IS NOT NULL) OR (${t.jobPostingId} IS NOT NULL)`,
    ),
    // The snapshot tier shares the closed domain of job_reach.match_tier. NULL-tolerant:
    // every legacy row, and any V1 row written before a tier was resolvable, is NULL.
    check(
      "applications_match_tier_chk",
      sql`${t.matchTier} IS NULL OR ${t.matchTier} IN (1, 2)`,
    ),
    // Month counts are durations; a negative one is always a bug, never data.
    check(
      "applications_snapshot_months_nonneg_chk",
      sql`(${t.skillMonths} IS NULL OR ${t.skillMonths} >= 0) AND (${t.industryMonths} IS NULL OR ${t.industryMonths} >= 0)`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; carried by the migration (BL-26 parity fix)

