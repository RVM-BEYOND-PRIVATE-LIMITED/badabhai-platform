/**
 * Canonical Domain -> Skill taxonomy (migration 0076).
 *
 * THE ONE CANONICAL RELATIONSHIP SET. Three join tables that make a single
 * `skill_id` travel from worker profiling, through the employer posting flow, into
 * the shape the existing match engine already understands:
 *
 *     job_domain --< job_domain_skill >-- skill      (the taxonomy: what this trade normally needs)
 *     job_posting --< job_posting_skill >-- skill    (what THIS company actually asked for)
 *     worker_profiles --< worker_profile_skill >-- skill  (what THIS worker actually has)
 *
 * ---------------------------------------------------------------------------
 * WHY `job_domain_id` AND NOT `skill.domain_id`
 * ---------------------------------------------------------------------------
 * Two disjoint id spaces both call themselves "domain" and neither is a superset
 * of the other:
 *
 *   * `skill.domain_id` — 11 hand-minted slugs ("cnc-machining", "welding", ...)
 *     living in a TypeScript constant (`@badabhai/taxonomy` SKILL_DOMAINS). No FK,
 *     no table. Declared IMMUTABLE by ADR-0030 SG-5: a re-domain is deprecate +
 *     recreate, never an UPDATE.
 *   * `job_domain.job_domain_id` — 4,071 `jd_*` rows (ISCO-08 + NCO-2015), the
 *     occupation catalogue `worker_profiles.job_domain_id` already points at.
 *
 * Mapping the 11 slugs onto the 4,071 rows would re-domain every shipped skill,
 * which SG-5 defines as deprecate-and-recreate — i.e. it would invalidate all 66
 * live `skill_id`s and every `worker_profiles.skills` / `job_postings.skill_ids`
 * value referencing them. That is a destructive migration and it is not on the table.
 *
 * So: `job_domain_id` is the SOLE canonical domain authority for everything in this
 * file, and `skill.domain_id` is demoted to LEGACY METADATA — still read by the
 * shipped domain-scoped ANN pre-filter, never the runtime domain relationship. It is
 * made nullable in this migration so a canonical skill minted by the taxonomy
 * bootstrap is not forced to claim one of the 11 legacy slugs.
 *
 * ---------------------------------------------------------------------------
 * MATERIALIZED, NOT RESOLVED PER REQUEST
 * ---------------------------------------------------------------------------
 * `job_domain_skill` holds FINAL, already-resolved rows. The employer read is
 * `WHERE job_domain_id = $1 AND status = 'active'` — one index probe, no recursive
 * CTE, no LLM, no embedding, no vector search.
 *
 * ISCO inheritance still happens, but OFFLINE, in the bootstrap that writes this
 * table: hierarchy -> inherit -> apply specific-domain overrides -> resolve -> write
 * final rows. `source='inherited'` + `inherited_from_job_domain_id` keep that
 * provenance auditable after the fact. This mirrors `job_reach`'s discipline
 * (materialized projection + `computed_at` + idempotent rebuild), NOT
 * `profiling_family_binding`'s per-request specificity ladder — that ladder is the
 * offline INPUT here, not the runtime read.
 *
 * ---------------------------------------------------------------------------
 * INVARIANTS
 * ---------------------------------------------------------------------------
 * - Editing one company's posting must NEVER mutate `job_domain_skill`. The
 *   taxonomy proposes defaults; `job_posting_skill` records the company's decision.
 *   Nothing in the request path writes `job_domain_skill` — enforced by there being
 *   no such writer, and asserted in the API tests.
 * - Invariant #4 (ADR-0036): none of these tables changes ranking semantics. They
 *   establish a common canonical id space and stop there. Required-vs-preferred is
 *   RECORDED here and deliberately NOT consumed by the match engine; that needs its
 *   own ADR + engine_version bump.
 * - SG-5: `skill_id` and `job_domain_id` are immutable, never-reused id spaces. Both
 *   FKs are therefore ON DELETE NO ACTION (drizzle's default) — a row is deprecated,
 *   never deleted, so a cascade could only ever mask a mistake. The two FKs that DO
 *   cascade point at owned entities (a profile, a posting) whose deletion genuinely
 *   should take their skill rows with them.
 * - PII: none of these tables stores free text. See the `evidence_ref` note on
 *   `worker_profile_skill` — it is the one column where a careless writer could leak
 *   a transcript, and it is contractually an opaque id.
 * - RLS: `.enableRLS()` in the model; FORCE + REVOKE carried by migration 0076.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  uuid,
  integer,
  smallint,
  real,
  timestamp,
  index,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";

import { jobDomains } from "./occupation";
import { skills } from "./skill";
import { workerProfiles } from "./profile";
import { jobPostings } from "./job";

// ===========================================================================
// Shared vocabularies
// ===========================================================================

/**
 * Whether a skill is core to the work or a differentiator.
 *
 * ONE enum column rather than the two independent booleans (`required_default` +
 * `preferred_default`) the brief sketched. Two booleans admit a fourth state that has
 * no meaning — both true — and would need a CHECK to forbid it anyway; a single
 * column makes the illegal state unrepresentable instead of merely rejected.
 */
export type SkillRequirement = "required" | "preferred";

/** How a `job_domain_skill` row came to exist. */
export type JobDomainSkillSource =
  /** Proposed by the offline taxonomy bootstrap's LLM pass, then validated. */
  | "llm_bootstrap"
  /** Resolved down the ISCO ladder from an ancestor domain (see `inheritedFrom`). */
  | "inherited"
  /** Hand-authored or hand-corrected by ops. Always wins a materialization conflict. */
  | "curated";

/** Lifecycle of a taxonomy edge; mirrors `skill.status` / `job_domain.status`. */
export type JobDomainSkillStatus = "active" | "provisional" | "deprecated";

/** How a worker came to be credited with a skill. */
export type WorkerProfileSkillSource =
  /** Canonicalized from a phrase the profiling LLM extracted from the interview. */
  | "llm_extraction"
  /** The worker themselves confirmed it in the app. Outranks extraction. */
  | "worker_confirmed"
  /** Entered by ops on the worker's behalf. */
  | "ops";

/** Self-reported depth. Deliberately coarse — a worker is not asked to self-grade finely. */
export type WorkerSkillLevel = "beginner" | "intermediate" | "advanced";

/** How a skill got onto a specific company's posting. */
export type JobPostingSkillSource =
  /** Ticked from the `job_domain_skill` recommendations. The normal path — no AI involved. */
  | "domain_default"
  /** Typed by the employer and resolved through the existing canonicalizer. */
  | "employer_custom";

// ===========================================================================
// job_domain_skill — the canonical taxonomy edge
// ===========================================================================

export const jobDomainSkills = pgTable(
  "job_domain_skill",
  {
    jobDomainId: text("job_domain_id")
      .notNull()
      .references(() => jobDomains.jobDomainId),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.skillId),
    /**
     * What the taxonomy RECOMMENDS this skill be treated as. A suggestion only: the
     * employer's own choice is recorded on `job_posting_skill.requirement` and is the
     * truth for that posting.
     */
    defaultRequirement: text("default_requirement")
      .$type<SkillRequirement>()
      .notNull()
      .default("preferred"),
    /**
     * Display ordering within a requirement band, 0..100, higher first. Distinct from
     * `confidence`: relevance is "how central is this skill to this trade", confidence
     * is "how sure is the generator that this edge is real at all". A hand-curated edge
     * can be low-relevance and total-confidence at the same time.
     *
     * NEVER an input to ranking (invariant #4) — this orders a picker, not a feed.
     */
    relevance: smallint("relevance").notNull().default(50),
    /** Generator certainty 0..1. NULL for `curated` rows, where the question is moot. */
    confidence: real("confidence"),
    source: text("source").$type<JobDomainSkillSource>().notNull(),
    /**
     * The ancestor this edge was resolved down from. Set only when
     * `source='inherited'` (CHECK below) — it is what makes an inherited edge
     * auditable back to the domain a human actually authored.
     */
    inheritedFrom: text("inherited_from_job_domain_id").references(() => jobDomains.jobDomainId),
    status: text("status").$type<JobDomainSkillStatus>().notNull().default("active"),
    /**
     * When the offline materializer last wrote this row. Same role as
     * `job_reach.computed_at`: it is how a partial or stale rebuild is detected, and
     * it is what a resumable bootstrap uses as its cursor.
     */
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * The natural key IS the pair. Makes the materializer's write an
     * `ON CONFLICT (job_domain_id, skill_id) DO UPDATE`, makes a duplicate edge
     * impossible, and its leading column serves the one runtime read this whole table
     * exists for: "the skills for this domain".
     */
    primaryKey({ columns: [t.jobDomainId, t.skillId] }),
    /** Reverse lookup: "which trades want this skill". Also the FK-referencing index. */
    index("job_domain_skill_skill_id_idx").on(t.skillId),
    /** FK-referencing column; Postgres does not auto-index it. */
    index("job_domain_skill_inherited_from_idx").on(t.inheritedFrom),
    check(
      "job_domain_skill_requirement_chk",
      sql`${t.defaultRequirement} IN ('required', 'preferred')`,
    ),
    check(
      "job_domain_skill_source_chk",
      sql`${t.source} IN ('llm_bootstrap', 'inherited', 'curated')`,
    ),
    check(
      "job_domain_skill_status_chk",
      sql`${t.status} IN ('active', 'provisional', 'deprecated')`,
    ),
    check("job_domain_skill_relevance_chk", sql`${t.relevance} BETWEEN 0 AND 100`),
    check(
      "job_domain_skill_confidence_chk",
      sql`${t.confidence} IS NULL OR (${t.confidence} >= 0 AND ${t.confidence} <= 1)`,
    ),
    /** An inheritance pointer only ever exists on an inherited row. */
    check(
      "job_domain_skill_inherited_from_chk",
      sql`${t.inheritedFrom} IS NULL OR ${t.source} = 'inherited'`,
    ),
    /** A domain cannot inherit from itself — that is what a non-inherited row means. */
    check(
      "job_domain_skill_no_self_inherit_chk",
      sql`${t.inheritedFrom} IS NULL OR ${t.inheritedFrom} <> ${t.jobDomainId}`,
    ),
  ],
).enableRLS();

// ===========================================================================
// worker_profile_skill — the AUTHORED worker skill relation
// ===========================================================================

/**
 * The canonical, authoritative record of what a worker can do.
 *
 * THIS IS THE SOURCE OF TRUTH, and the other two representations are downstream of it:
 *
 *   worker_profile_skill  (authored — here)
 *         |
 *         +--> worker_skill              DERIVED projection, 18 closed `mskill_*` units,
 *         |                              drives `job_reach`. Rebuilt, never authored.
 *         +--> worker_profiles.skills    LEGACY jsonb string[]. Compatibility only,
 *                                        deprecated, removed in a later validated migration.
 *
 * `worker_skill` is NOT being replaced or widened — its own schema calls it a
 * "DERIVED, rebuildable projection ... never a system of record for anything a worker
 * told us", it carries a closed 18-member vocabulary, and its hot path is a partial
 * covering index with a hand-appended INCLUDE payload that a schema change would put
 * at risk. It keeps its exact meaning; only its INPUT moves here.
 */
export const workerProfileSkills = pgTable(
  "worker_profile_skill",
  {
    workerProfileId: uuid("worker_profile_id")
      .notNull()
      .references(() => workerProfiles.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.skillId),
    /**
     * Canonicalizer confidence 0..1 for `llm_extraction` rows. NULL when a human
     * asserted the skill directly, where a machine confidence would be a fiction.
     */
    confidence: real("confidence"),
    source: text("source").$type<WorkerProfileSkillSource>().notNull(),
    /**
     * PRIVACY BOUNDARY — READ BEFORE WRITING THIS COLUMN.
     *
     * An OPAQUE INTERNAL ID pointing at the artifact that evidenced the skill: an
     * `ai_jobs.id`, a turn id, an `unresolved_phrase.id`. It is NOT a quote, NOT a
     * transcript fragment, NOT the phrase the worker said, and NOT anything a worker
     * typed or spoke.
     *
     * CLAUDE.md §3 keeps raw PII out of logs, events, audit records and analytics, and
     * this row is joined into all four. A raw utterance here ("I worked at Sharma
     * Engineering for Rakesh bhai") would carry an employer and a name straight into
     * the matching surface, past the pseudonymization gateway that exists precisely to
     * stop that. Store the pointer; resolve it server-side when a human needs the quote.
     */
    evidenceRef: text("evidence_ref"),
    /**
     * MONTHS, not years — matching `worker_skill.months_bucketed` so the derivation
     * downstream is a copy rather than a lossy unit conversion. NULL = not stated;
     * 0 = stated as none, which is a different fact.
     */
    monthsExperience: integer("months_experience"),
    level: text("level").$type<WorkerSkillLevel>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** One row per (profile, skill). Makes the extraction write an idempotent upsert. */
    primaryKey({ columns: [t.workerProfileId, t.skillId] }),
    /** Reverse lookup: "which workers have this skill". The FK-referencing index. */
    index("worker_profile_skill_skill_id_idx").on(t.skillId),
    check(
      "worker_profile_skill_source_chk",
      sql`${t.source} IN ('llm_extraction', 'worker_confirmed', 'ops')`,
    ),
    check(
      "worker_profile_skill_confidence_chk",
      sql`${t.confidence} IS NULL OR (${t.confidence} >= 0 AND ${t.confidence} <= 1)`,
    ),
    check(
      "worker_profile_skill_months_chk",
      sql`${t.monthsExperience} IS NULL OR ${t.monthsExperience} >= 0`,
    ),
    check(
      "worker_profile_skill_level_chk",
      sql`${t.level} IS NULL OR ${t.level} IN ('beginner', 'intermediate', 'advanced')`,
    ),
  ],
).enableRLS();

// ===========================================================================
// job_posting_skill — what THIS company asked for
// ===========================================================================

/**
 * The employer's actual selection for one posting.
 *
 * Deliberately NOT a replacement for the four jsonb arrays on `job_postings`. Those
 * are four different things and only two of them are about matching:
 *   * `skill_phrases` / `skill_ids` — descriptive, ADR-0030, explicitly never ranked
 *   * `match_skill_ids` / `reach_skill_ids` — the deterministic TIER 1 / TIER 2 pair,
 *     written only by `PublishReachService`, `reach_skill_ids` GIN-indexed and
 *     load-bearing for feed reconciliation
 *
 * This table adds the canonical-id relation alongside them. Nothing is removed; the
 * arrays stay authoritative for their existing readers until a later, separately
 * validated migration retires them (Phase F/G).
 */
export const jobPostingSkills = pgTable(
  "job_posting_skill",
  {
    jobPostingId: uuid("job_posting_id")
      .notNull()
      .references(() => jobPostings.id, { onDelete: "cascade" }),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.skillId),
    /**
     * The company's own call. Seeded from `job_domain_skill.default_requirement` when
     * the employer ticks a recommendation, but overridable and thereafter independent:
     * a later change to the taxonomy default must not rewrite a saved posting.
     */
    requirement: text("requirement").$type<SkillRequirement>().notNull(),
    source: text("source").$type<JobPostingSkillSource>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.jobPostingId, t.skillId] }),
    /** Reverse lookup: "which postings want this skill". The FK-referencing index. */
    index("job_posting_skill_skill_id_idx").on(t.skillId),
    check("job_posting_skill_requirement_chk", sql`${t.requirement} IN ('required', 'preferred')`),
    check(
      "job_posting_skill_source_chk",
      sql`${t.source} IN ('domain_default', 'employer_custom')`,
    ),
  ],
).enableRLS();
