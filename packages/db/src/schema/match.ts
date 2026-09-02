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
// job_reach_widen (migration 0090) — Policy 27 third leg: the EXPIRY half.
//
// One row per OPS widen request (TD127): which `mskill_*` ids were appended to the
// posting's reach set, by which opaque ops actor, and WHEN the grant ends
// (`match_config.widen_expiry_hours` from the request time). The expiry sweep reads
// this table as its authoritative work list, retracts exactly the expired ids nothing
// else protects, re-materializes the posting from its base set, and marks the rows
// `retracted_at`.
//
// WHY PROVENANCE IS A TABLE AND NOT A TTL COLUMN ON `job_reach`: a reach row is
// qualified by the BEST skill across the whole set — there is no per-skill attribution
// to expire, and one worker may be reachable through BOTH a base and a widened skill.
// The system of record for "what is widened right now" must live beside the reach set
// itself (`job_postings.reach_skill_ids`), or a retraction could not restore it.
//
// APPEND-ONLY IN SPIRIT, RETRACTED-IN-FACT: rows are never deleted; `retracted_at`
// records that the sweep has processed them. A re-widened id gets a NEW row whose
// active expiry protects it from an older row's sweep — the retract step excludes any
// id still held by a non-retracted row or present in `match_skill_ids`.
//
// PII-FREE: ids, closed-vocabulary skill ids and timestamps only. `ops_actor_id` is
// the same OPAQUE actor id the `job_posting.reach_widened` event carries. No FK to it
// (mirrors `job_postings.created_by`).
//
// DPDP: no worker data at all — erasure needs no path here.
// ---------------------------------------------------------------------------
export const jobReachWiden = pgTable(
  "job_reach_widen",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobPostingId: uuid("job_posting_id")
      .notNull()
      .references(() => jobPostings.id, { onDelete: "cascade" }),
    // The `mskill_*` ids THIS request appended (deduped, sorted at write). jsonb array of
    // strings, same shape as `job_postings.match_skill_ids`.
    addedSkillIds: jsonb("added_skill_ids").$type<string[]>().notNull(),
    // When the grant ends. `expires_at <= now()` is the sweep's candidacy predicate.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // NULL = still in force. Set once the sweep has retracted these ids (or found the
    // posting gone/closed — a terminal posting's sets rebuild on republish anyway).
    retractedAt: timestamp("retracted_at", { withTimezone: true }),
    // Opaque ops actor from the widen request envelope. No FK, never a name.
    opsActorId: uuid("ops_actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // THE SWEEP PROBE: due, un-retracted grants. Partial so the steady-state table
    // (everything retracted) holds one tiny index.
    index("job_reach_widen_due_idx")
      .on(t.expiresAt)
      .where(sql`${t.retractedAt} IS NULL`),
    // Per-posting audit walk ("what was ever widened here?") + the active-set check the
    // retract step runs before removing an id.
    index("job_reach_widen_posting_idx").on(t.jobPostingId),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0090

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


// ---------------------------------------------------------------------------
// matching_catalog (migration 0099) — RVM-RATIFIED DOMAIN TRUTH as published config.
//
// The role registry, domains, families, directed adjacency multipliers, the
// function/collar-tier matrices and the per-role attribute whitelists. Master-context
// §32 keeps every one of these OUTSIDE the schema on purpose: after this table exists,
// taxonomy churn is a data publish with RVM sign-off, not a deploy. Spec §D step 2
// calls it "the highest-leverage single change" in the matching plan.
//
// WHY THIS IS A SEPARATE TABLE FROM `match_config`, WHICH HAS THE IDENTICAL SHAPE
// (owner ruling, 2026-09-02 — recorded so this reads as a rejection, not an oversight):
//   - Different sign-off authority. `match_config` is engineering knobs; this is RVM
//     domain truth. Publishing a taxonomy version must not require republishing engine
//     knobs, or the reverse.
//   - Different cadence. Knobs move during tuning; taxonomy moves when RVM signs.
//   - Decisive: bundled, every `boost_supply_floor` tweak would rewrite a new row
//     carrying the whole taxonomy blob, and the audit trail stops telling you what
//     actually changed. Config rows that move on different clocks do not share a row.
//
// COLUMN NAMES mirror `pricing_catalog` and `match_config` exactly — `catalog` /
// `revision` / `updated_by`, not `catalog_json` / `version` / `published_by`. The
// convention is 2-0 in the codebase; a third config table with its own vocabulary is a
// permanent tax and triples the cost of ever extracting a shared config-catalog module.
// `updated_by` is also simply accurate: flipping `is_active` IS an update to the row.
//
// PII-FREE by shape: machine ids, display labels and numbers only. Invariant #4 — these
// are DETERMINISTIC matching parameters; an LLM neither writes nor reads them, and it
// may never produce a canonical id.
// ---------------------------------------------------------------------------
export const matchingCatalog = pgTable(
  "matching_catalog",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The whole taxonomy blob. Loose jsonb here (like pricing_catalog.catalog and
    // match_config.config); @badabhai/matching-catalog owns the Zod shape and the
    // publish-time validator. Never trusted unvalidated.
    catalog: jsonb("catalog").notNull(),
    // Monotonic catalog revision, bumped on each RVM publish. UNIQUE — a revision
    // number is a citation in a sign-off packet, so it must never be reusable.
    revision: integer("revision").notNull().default(1),
    // AT MOST ONE active row (partial unique index below). Deliberately NOT
    // "exactly one": the fixture ships inactive and a fresh database legitimately has
    // ZERO active catalogs, which is the state `getActive()` reports as null.
    isActive: boolean("is_active").notNull().default(false),
    // Opaque ops/RVM actor who published this revision (no PII). Mirrors
    // pricing_catalog.updated_by and match_config.updated_by.
    updatedBy: uuid("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At most one active catalog row (mirrors pricing_catalog_active_uq).
    uniqueIndex("matching_catalog_active_uq")
      .on(t.isActive)
      .where(sql`${t.isActive}`),
    // A revision number is never reused, active or not.
    uniqueIndex("matching_catalog_revision_uq").on(t.revision),
    check("matching_catalog_revision_positive_chk", sql`${t.revision} >= 1`),
    // STRUCTURAL TEETH ON THE P1 INVARIANT — an invalid catalog cannot become active.
    // Deliberately shallow: it pins the top-level container types only, so a row that
    // is structurally garbage cannot be flipped active by a hand-written UPDATE that
    // bypasses the API. Semantic validity (dangling adjacency edges, out-of-range
    // multipliers, illegal function values) is NOT expressible here without a
    // PL/pgSQL trigger, and is enforced by validateMatchingCatalog() at publish time.
    // Bumping MATCHING_CATALOG_SCHEMA_VERSION in a way that changes these containers
    // REQUIRES a follow-up migration to this constraint.
    check(
      "mc_active_shape_chk",
      sql`${t.isActive} = false OR (
        jsonb_typeof(${t.catalog} -> 'schemaVersion') = 'number'
        AND jsonb_typeof(${t.catalog} -> 'domains') = 'array'
        AND jsonb_typeof(${t.catalog} -> 'families') = 'array'
        AND jsonb_typeof(${t.catalog} -> 'roles') = 'array'
        AND jsonb_typeof(${t.catalog} -> 'adjacency') = 'array'
        AND jsonb_typeof(${t.catalog} -> 'functionMultiplier') = 'object'
        AND jsonb_typeof(${t.catalog} -> 'collarTierBand') = 'object'
      )`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0099

export type MatchingCatalogRow = typeof matchingCatalog.$inferSelect;
export type NewMatchingCatalogRow = typeof matchingCatalog.$inferInsert;
