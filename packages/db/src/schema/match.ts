/**
 * Matching domain — the derived per-worker match inputs (skills, industry tenure),
 * the materialized `job_reach` set, and the V1 rank-rule config row.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  integer,
  smallint,
  boolean,
  timestamp,
  date,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { workers } from "./worker";
import { skills } from "./skill";
import { jobPostings } from "./job";

/**
 * Where a `worker_skill` row came from. The D2 backfill OWNS `derived_coarse` rows and
 * only those — it may rewrite or delete them freely. `interview` (the worker said it)
 * and `ops` (a human corrected it) are HUMAN-AUTHORED and the backfill must never touch
 * them; that asymmetry is what makes the backfill safe to re-run forever.
 */
export type WorkerSkillSource = "derived_coarse" | "interview" | "ops";

// worker_skill — one row per (worker, match skill). The reach driver.
export const workerSkills = pgTable(
  "worker_skill",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    // A closed-vocabulary id. In V1 this is always a `kind='match_skill'` row; the FK
    // pins it to the real vocabulary (SG-3 discipline: never free text, never invented).
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.skillId),
    // DENORMALIZED from `skill.industry_id` so the industry filter never needs a join on
    // the hot reach path (the same denormalization `skill_alias.domain_id` uses).
    industryId: text("industry_id").notNull(),
    // Experience on this skill, BUCKETED (config `month_bucket`, 6 at launch). Bucketed —
    // not exact — on purpose: coarse history cannot support month-precision, and the rank
    // rule's tier floor is a 36-month threshold, not a fine-grained sort.
    monthsBucketed: integer("months_bucketed").notNull().default(0),
    // Per-skill stint window. NULL at launch (COARSE history — no per-job stints yet);
    // the columns exist now so the later fine-grained interview writer needs no migration.
    startedAt: date("started_at"),
    endedAt: date("ended_at"),
    // Does the worker WANT this kind of work? The reach set is opt-in: `WHERE wants` is
    // part of the driver index below, so a worker who turns a skill off leaves the index.
    wants: boolean("wants").notNull().default(true),
    source: text("source").$type<WorkerSkillSource>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Natural key: at most one row per (worker, skill). Makes every writer — the D2
    // backfill, the interview, an ops edit — a safe ON CONFLICT upsert.
    uniqueIndex("worker_skill_worker_skill_uq").on(t.workerId, t.skillId),
    // ── THE REACH DRIVER ──────────────────────────────────────────────────────
    // Both hot paths execute exactly this shape:
    //   (a) the ③ materialization — INSERT..SELECT ... WHERE skill_id = ANY($reach) AND wants
    //   (b) the live "how many workers can this posting reach?" count
    // The migration hand-appends `INCLUDE ("worker_id","months_bucketed")` so BOTH are
    // index-only scans that never touch the heap. drizzle-kit 0.31 cannot model INCLUDE
    // (see indexes.d.ts IndexConfig) — the same modelling gap 0037 hit with NULLS NOT
    // DISTINCT on `unresolved_phrase_uq`, handled the same way: model what Drizzle can
    // express, hand-append the clause it cannot, and never regenerate over it. The
    // snapshot records the non-INCLUDE form; because name + key columns + WHERE all
    // match, a future `db:generate` is a no-op on this index (it will not drop it).
    index("worker_skill_reach_idx")
      .on(t.skillId)
      .where(sql`${t.wants}`),
    check("worker_skill_months_nonneg_chk", sql`${t.monthsBucketed} >= 0`),
    check(
      "worker_skill_source_chk",
      sql`${t.source} IN ('derived_coarse', 'interview', 'ops')`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0053

// worker_industry_tenure — calendar months in an industry, per worker. A materialized
// projection: (worker_id, industry_id) is the natural key AND the primary key, so the
// D2 rebuild is a plain upsert. `calendar_months` is CALENDAR time (overlapping skills
// are not double counted) and is clamped to at least the worker's longest skill tenure
// (the E8 clamp) — a worker cannot have 5 years on a skill but 2 years in the industry.
export const workerIndustryTenure = pgTable(
  "worker_industry_tenure",
  {
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    industryId: text("industry_id").notNull(),
    calendarMonths: integer("calendar_months").notNull().default(0),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workerId, t.industryId] }),
    check("worker_industry_tenure_months_nonneg_chk", sql`${t.calendarMonths} >= 0`),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0053

// ---------------------------------------------------------------------------
// job_reach — Matching V1 (migration 0055). The MATERIALIZED-ON-WRITE reach set:
// one row per (posting, worker) the posting can reach, computed when the posting is
// published/edited rather than at feed time.
//
// It is a CACHE, not a system of record: every row is reproducible from
// `job_postings.reach_skill_ids` × `worker_skill` by re-running `db:materialize:reach`.
// Truncating it costs a rebuild, never data.
//
// WHY MATERIALIZE: the feed read becomes "give me this worker's postings" — a single
// index-only scan of `job_reach_worker_idx` — instead of a per-request GIN scan over
// every open posting. The write side pays once per publish/edit.
//
// TIER (E6, best-tier-wins): 1 = the worker holds a skill the poster ACTUALLY ASKED FOR
// (`job_postings.match_skill_ids`); 2 = reached only through a `skill_related`
// neighbour. A worker who qualifies both ways is TIER 1 — the materializer's MIN()
// enforces that, and `matched_skill_id` names the skill that achieved the tier.
//
// PRIVACY (invariant #2): PII-FREE — two opaque UUIDs, a smallint, one closed-vocabulary
// skill id, a timestamp. `worker_id` → `workers` is the only join back to identity, the
// same shape `applications` has had since ADR-0009.
//
// DPDP ERASURE: worker_id CASCADEs from `workers`, so the existing single-statement hard
// delete removes a deleted worker from every posting's reach set atomically — no
// deletion-service change. job_posting_id CASCADEs too, so deleting a posting takes its
// reach set with it.
//
// Invariant #4: DETERMINISTIC set membership from a deterministic rule. No LLM ranks,
// scores, or decides here — `match_tier` is a set-membership fact, not a model output.
// ---------------------------------------------------------------------------
export const jobReach = pgTable(
  "job_reach",
  {
    jobPostingId: uuid("job_posting_id")
      .notNull()
      .references(() => jobPostings.id, { onDelete: "cascade" }),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    // 1 = direct (a posted match skill) · 2 = related-skill only. smallint: the domain is
    // two values and this table is the widest row-count in the system.
    matchTier: smallint("match_tier").notNull(),
    // WHICH skill earned the tier — what the "why am I seeing this?" line renders from,
    // and what makes a reach row auditable without re-running the materializer.
    matchedSkillId: text("matched_skill_id")
      .notNull()
      .references(() => skills.skillId),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The natural key IS the pair: a worker appears at most once per posting. Makes the
    // materializer a plain INSERT .. ON CONFLICT DO UPDATE (idempotent re-runs) and makes
    // a double-count structurally impossible.
    primaryKey({ columns: [t.jobPostingId, t.workerId] }),
    // ── THE FEED READ ─────────────────────────────────────────────────────────
    // "which postings can this worker see?" — WHERE worker_id = $1. The migration
    // hand-appends INCLUDE (job_posting_id, match_tier, matched_skill_id) so the whole
    // feed page comes out of the index with no heap fetch. (The PK is
    // (job_posting_id, worker_id), so it CANNOT serve a worker-leading lookup — this
    // index is not redundant with it.) drizzle-kit 0.31 cannot model INCLUDE; see the
    // same note on worker_skill_reach_idx.
    index("job_reach_worker_idx").on(t.workerId),
    check("job_reach_match_tier_chk", sql`${t.matchTier} IN (1, 2)`),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0055

// ---------------------------------------------------------------------------
// match_config — Matching V1 (migration 0057). The knobs of the V1 rank rule, held as
// ONE ACTIVE jsonb row. A DELIBERATE CLONE of the `pricing_catalog` shape (ADR-0013
// Decision A): single active row + monotonic `revision` + partial unique on is_active +
// opaque `updated_by` + timestamps. Prior revisions stay as history rows.
//
// Same discipline as pricing: the engine loads the ACTIVE row and VALIDATES it before
// use, and FAILS CLOSED to a typed default if it does not parse. An unvalidated config
// row must never be trusted — this table is ops-editable.
//
// The V1 keys (seeded by `db:seed:match:vocabulary`, NOT by this migration — the
// migration ships structure, the seeder ships values, exactly like pricing):
//   engine_version "v1.0" · month_bucket 6 · max_skills_per_posting 3 ·
//   related_skills_default "on" · max_consecutive_same_company 2 ·
//   applicant_quota "off" · tier_floor_months 36 · free_unlock_credits 50 ·
//   boost_supply_floor 25
//
// PII-FREE: enum-ish strings and integers only. Invariant #4: these are DETERMINISTIC
// rule parameters — an LLM neither writes nor reads them.
// ---------------------------------------------------------------------------
export const matchConfig = pgTable(
  "match_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The whole V1 knob set. Loose jsonb here (like pricing_catalog.catalog); the engine
    // owns the Zod schema and validates on load.
    config: jsonb("config").notNull(),
    // Monotonic revision, bumped on each ops edit.
    revision: integer("revision").notNull().default(1),
    // Exactly one active row (partial unique index below).
    isActive: boolean("is_active").notNull().default(true),
    // Opaque ops actor who wrote this revision (no PII). Mirrors pricing_catalog.updated_by.
    updatedBy: uuid("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At most one active config row at a time (mirrors pricing_catalog_active_uq).
    uniqueIndex("match_config_active_uq")
      .on(t.isActive)
      .where(sql`${t.isActive}`),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0057

export type MatchConfig = typeof matchConfig.$inferSelect;
export type NewMatchConfig = typeof matchConfig.$inferInsert;

