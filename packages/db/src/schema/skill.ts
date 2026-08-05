/**
 * Skill vocabulary domain (ADR-0030 / TAX-1) — canonical skills, their aliases, the
 * below-floor growth queue, and the match-skill adjacency graph.
 */
import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  vector,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import type {
  LanguageCode,
} from "@badabhai/types";

// ===========================================================================
// ADR-0030 / TAX-1 — embedding-based skill canonicalization vocabulary
// ---------------------------------------------------------------------------
// Three ADDITIVE tables + a second HNSW vector index for domain-scoped skill
// resolution. pgvector is ALREADY enabled (migration 0001) and 768 is the house
// embedding dimension (worker_profiles.embedding, Vertex text-multilingual-
// embedding-002) — TAX-1 introduces no new extension. No shipped column is touched.
//
// - SG-1: unresolved_phrase.phrase stores PSEUDONYMIZED text only, and there is NO
//   worker_id column (an aggregate phrase+count queue) — so it is NOT a per-worker
//   DSAR surface under ADR-0026. Treat all phrase text as untrusted (hostile) input.
// - SG-3: skill.skill_id is a closed, immutable id space; the resolver (TAX-6)
//   re-validates any resolved id against this table on write (mirrors normalize_role_id).
// - SG-5: additive; skill_id is IMMUTABLE + never reused; versioned.
// - Invariant #4: skill_alias.embedding is a CANONICALIZATION artifact — it never
//   enters the reach RANK path (that would need the separate skills-in-ranking ADR).
// - RLS: .enableRLS() in the model (service-role backend today; RLS not finalized —
//   infra/supabase/rls-plan.md).
// ===========================================================================

/** Provenance of a canonical skill / alias (ADR-0030 four-pillar sources). */
export type SkillSource = "esco" | "onet" | "nco" | "rvm";
/** Lifecycle of a canonical skill; `provisional` = human-promoted from unresolved. */
export type SkillStatus = "active" | "provisional" | "deprecated";
/** Lifecycle of an unresolved (below-floor) phrase in the growth queue. */
export type UnresolvedPhraseStatus = "open" | "clustered" | "resolved";

/**
 * Matching V1 (migration 0052) — the TWO KINDS a `skill` row can be.
 *
 * `match_skill` — a MATCHABLE unit of work (the closed `mskill_*` vocabulary in
 *   @badabhai/taxonomy `MATCH_SKILLS`). Only these ids may appear in
 *   `job_postings.match_skill_ids` / `reach_skill_ids`, `worker_skill.skill_id`,
 *   `job_reach.matched_skill_id`, or a `skill_related` pair.
 * `attribute` — everything the pre-V1 vocabulary already held (controls, machines,
 *   certifications, soft attributes). Descriptive; NEVER matched on directly.
 *
 * The DEFAULT is `attribute` on purpose: every already-shipped `skill` row keeps its
 * exact meaning after the migration (an expand-only, zero-behaviour-change backfill).
 */
export type SkillKind = "match_skill" | "attribute";

// The immutable canonical skill vocabulary. `skill_id` is a text PK, NEVER reused.
export const skills = pgTable(
  "skill",
  {
    skillId: text("skill_id").primaryKey(),
    labelEn: text("label_en").notNull(),
    labelHi: text("label_hi"),
    // IMMUTABLE alongside skill_id (a re-domain = deprecate + recreate). skill_alias
    // denormalizes this for the domain-scoped ANN filter and relies on it not changing.
    domainId: text("domain_id").notNull(),
    source: text("source").$type<SkillSource>().notNull(),
    status: text("status").$type<SkillStatus>().notNull().default("provisional"),
    version: integer("version").notNull().default(1),
    // TAX-9: the deprecation CROSSWALK — the immutable successor id. Set ONLY when
    // status='deprecated' (CHECK below). Ids are never reused/renamed (SG-5): change is
    // expressed as version bump + status transition + this pointer, and affected
    // worker/job rows are re-tagged OFFLINE (`pnpm db:retag:skills`, dry-run first) —
    // never rewritten on the live path. Chains (A→B→C) are legal; the retag runner
    // resolves them to the terminal id and refuses cycles. Self-FK: a successor must
    // itself be a real skill row. ADDITIVE + nullable → migration 0039 is backward-safe.
    replacedBy: text("replaced_by").references((): AnyPgColumn => skills.skillId),
    // ── Matching V1 (migration 0052) ─────────────────────────────────────────
    // Splits the ONE vocabulary into the matchable half and the descriptive half
    // (see SkillKind above). NOT NULL with DEFAULT 'attribute' so the ALTER is a
    // metadata-only, zero-rewrite expand on Postgres 11+ and every shipped row keeps
    // its meaning; `db:seed:match:vocabulary` (D1) promotes the `mskill_*` ids to
    // 'match_skill'. Rollback = drop the column (nothing pre-V1 reads it).
    kind: text("kind").$type<SkillKind>().notNull().default("attribute"),
    // The industry this vocabulary entry belongs to (`ind_*`, @badabhai/taxonomy
    // INDUSTRIES). Matching V1 is industry-scoped: a `match_skill` is only ever
    // matched inside its own industry. NOT NULL with the launch industry as the
    // DEFAULT — every shipped row is manufacturing today, so the backfill is exact,
    // not a guess. `ind_quick_commerce` is the second industry V1 introduces.
    industryId: text("industry_id").notNull().default("ind_industrial_manufacturing"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("skill_domain_id_idx").on(t.domainId),
    // Matching V1: "give me the match-skill vocabulary for industry X" — the read the
    // match engine + the reach materializer both start from. Small reference table, but
    // this keeps it an index-only lookup instead of a seq scan on every posting publish.
    index("skill_industry_kind_idx").on(t.industryId, t.kind),
    check("skill_source_chk", sql`${t.source} IN ('esco', 'onet', 'nco', 'rvm')`),
    check("skill_status_chk", sql`${t.status} IN ('active', 'provisional', 'deprecated')`),
    // Pin the two kinds (mirrors SkillKind). Matching V1, migration 0052.
    check("skill_kind_chk", sql`${t.kind} IN ('match_skill', 'attribute')`),
    // Crosswalk discipline: a successor pointer only ever exists on a DEPRECATED row
    // (deprecated-without-successor is legal: retired, nothing to re-tag to).
    check(
      "skill_replaced_by_chk",
      sql`${t.replacedBy} IS NULL OR ${t.status} = 'deprecated'`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; service-role today (rls-plan.md, not finalized)

// Alias variants of a skill (label variants, spellings, Hinglish/regional forms).
// We embed the ALIASES, not the canonical label (ADR-0030). `domain_id` is
// DENORMALIZED from `skill` so a domain-scoped ANN search filters on this table.
export const skillAliases = pgTable(
  "skill_alias",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.skillId, { onDelete: "cascade" }),
    text: text("text").notNull(),
    lang: text("lang").$type<LanguageCode>(),
    source: text("source").$type<SkillSource>().notNull(),
    domainId: text("domain_id").notNull(),
    // Vertex text-multilingual-embedding-002, 768-dim (same as worker_profiles.embedding).
    // Nullable until embedded by TAX-4 (a staging-gated real provider call).
    embedding: vector("embedding", { dimensions: 768 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Domain-scoped ANN filter (ADR-0030); domain_id alone suffices (the HNSW does the
    // vector order, this pre-filters the domain).
    index("skill_alias_domain_id_idx").on(t.domainId),
    // FK-referencing column (Postgres does not auto-index it; the ON DELETE cascade needs it).
    index("skill_alias_skill_id_idx").on(t.skillId),
    // Second HNSW cosine index (the §7(a) capacity item) over alias embeddings.
    index("skill_alias_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
    check("skill_alias_source_chk", sql`${t.source} IN ('esco', 'onet', 'nco', 'rvm')`),
  ],
).enableRLS();

// The below-floor growth queue: PSEUDONYMIZED phrases that did not clear the
// confidence floor. NO worker_id (aggregate only) → not a per-worker DSAR surface.
export const unresolvedPhrases = pgTable(
  "unresolved_phrase",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phrase: text("phrase").notNull(), // PSEUDONYMIZED text only (SG-1)
    lang: text("lang").$type<LanguageCode>(),
    domainId: text("domain_id"),
    count: integer("count").notNull().default(1),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").$type<UnresolvedPhraseStatus>().notNull().default("open"),
    // Optional embedding for TAX-7 clustering (nullable until clustered).
    embedding: vector("embedding", { dimensions: 768 }),
  },
  (t) => [
    // One row per distinct phrase — enables the atomic count-increment upsert
    // (INSERT ... ON CONFLICT (phrase, domain_id, lang) DO UPDATE count = count + 1).
    // The migration adds NULLS NOT DISTINCT (PG15) by hand — this drizzle version
    // can't model it — so NULL domain/lang phrases still dedupe to one row.
    uniqueIndex("unresolved_phrase_uq").on(t.phrase, t.domainId, t.lang),
    index("unresolved_phrase_status_idx").on(t.status),
    check(
      "unresolved_phrase_status_chk",
      sql`${t.status} IN ('open', 'clustered', 'resolved')`,
    ),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// skill_related — Matching V1 (migration 0052). The "related skill" adjacency the
// TIER-2 reach set is built from: a posting's `reach_skill_ids` = its
// `match_skill_ids` ∪ every skill related to one of them.
//
// SYMMETRY IS A SEEDER + TEST INVARIANT, NOT A DB TRIGGER. Both directions (A→B and
// B→A) are stored as two rows. That is deliberate:
//   * a trigger would make the seeder's own writes recursive and would silently
//     "fix" a bad pair instead of failing the run;
//   * two plain rows keep the TIER-2 lookup a single index probe in ONE direction
//     (no OR / UNION), which is what the reach materializer actually executes.
// `db:seed:match:vocabulary` (D1) writes both rows for every
// MATCH_SKILL_RELATION_PAIRS entry and REFUSES to write an asymmetric, self-, or
// attribute-kind pair; `verify-match-v1.ts` re-asserts symmetry against the live DB.
//
// PII: none. Two closed-vocabulary skill ids — pure reference data, exactly like
// `skill` / `skill_alias` beside it. Invariant #4: this is DETERMINISTIC adjacency
// data consumed by the match engine; no LLM produces or reads it.
//
// The FKs are ON DELETE NO ACTION (drizzle's default) on purpose: `skill_id` is an
// immutable, never-reused id space (ADR-0030 SG-5) — a skill is DEPRECATED, never
// deleted, so a cascade would only ever mask a mistake.
// ---------------------------------------------------------------------------
export const skillRelated = pgTable(
  "skill_related",
  {
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.skillId),
    relatedSkillId: text("related_skill_id")
      .notNull()
      .references(() => skills.skillId),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The natural key IS the pair — makes the seeder's upsert an ON CONFLICT DO NOTHING
    // and makes a duplicated pair impossible. Also serves the forward lookup
    // (WHERE skill_id = ANY($posted)) that builds the reach set.
    primaryKey({ columns: [t.skillId, t.relatedSkillId] }),
    // The reverse lookup. Cheap, and it is what the symmetry assertion scans.
    index("skill_related_related_skill_id_idx").on(t.relatedSkillId),
    // A skill is never "related to" itself (that is what TIER 1 means).
    check("skill_related_no_self_chk", sql`${t.skillId} <> ${t.relatedSkillId}`),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0052

