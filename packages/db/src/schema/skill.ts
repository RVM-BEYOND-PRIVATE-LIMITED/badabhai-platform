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
  boolean,
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
 * Which vocabulary a below-floor phrase failed to resolve in (migration 0070).
 *
 * `skill` is every row written before Phase 8, which is why it is the column default —
 * the widening needs no backfill and breaks no existing writer.
 */
export type UnresolvedPhraseScope = "skill" | "occupation";

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
    // LEGACY DOMAIN METADATA — NOT the canonical domain relationship (migration 0076).
    //
    // Still IMMUTABLE per row (a re-domain = deprecate + recreate), and still what the
    // shipped domain-scoped ANN pre-filter reads via the `skill_alias.domain_id`
    // denormalization. What changed is its STATUS: the canonical domain <-> skill
    // relationship now lives in `job_domain_skill`, keyed on `job_domain.job_domain_id`
    // (`jd_*`), and this column is compatibility metadata.
    //
    // WHY IT IS NOW NULLABLE. These are 11 hand-minted slugs in a TypeScript constant
    // (SKILL_DOMAINS), disjoint from the 4,071-row `jd_*` catalogue. A canonical skill
    // minted by the taxonomy bootstrap belongs to a `job_domain`, and forcing it to also
    // claim one of the 11 legacy slugs would either invent a false fact or block the
    // insert. Dropping NOT NULL is permissive and reversible; the alternative — mapping
    // the slugs onto `jd_*` — is a re-domain of every shipped row, which SG-5 defines as
    // deprecate-and-recreate and would invalidate all 66 live skill ids.
    //
    // CONSEQUENCE FOR RETRIEVAL, stated plainly because it is a real edge: the domain-
    // scoped ANN filters `WHERE domain_id = $1`, so a NULL-domain skill is invisible to
    // it. That is correct for now — such skills are reached through `job_domain_skill` —
    // and the resolver moves onto that join in a later phase.
    domainId: text("domain_id"),
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
    // THE L0/L2 SEARCH KEY (migration 0076) — the same column, populated by the same
    // `normalizeOccupationText`, that `job_domain_alias.text_norm` already carries.
    //
    // This is the single biggest gap the canonicalizer has today: `canonicalize_skill`
    // goes pseudonymize -> embed -> ANN -> floor, with NOTHING before the embed. Every
    // phrase costs a vector call even when an exact alias is sitting in the table, and a
    // one-character typo has no cheap recovery. text_norm restores both rungs.
    //
    // NULL means "not normalized yet" and is the runner's resumability predicate
    // (`WHERE text_norm IS NULL`), exactly as on the domain side. It never means
    // "excluded" — that is `is_searchable`'s job, so the runner terminates.
    textNorm: text("text_norm"),
    // IS THIS ROW THE RETRIEVAL REPRESENTATIVE FOR ITS text_norm?
    //
    // Carries ONE of the three jobs it does on `job_domain_alias`: duplicate election.
    // Skills have no bucket rows and no ISCO shadowing, so reasons 1 and 2 do not apply
    // here — but reason 3 will, the moment the bootstrap grows this table from 131 rows
    // to thousands and two aliases of one skill collapse onto the same normalized form.
    //
    // DEFAULT false, matching the domain side, and that default is load-bearing: the
    // partial unique index below is `WHERE is_searchable`, so with every existing row
    // false, adding it cannot fail on a pre-existing duplicate. The normalizer runner
    // populates `text_norm` and elects one representative per (skill, text_norm, lang)
    // in the same pass. A losing duplicate KEEPS its row, its id and its paid embedding
    // and simply stops being retrievable — nothing is deleted (CLAUDE.md §10).
    //
    // Constant DEFAULT => metadata-only on PG11+, no table rewrite.
    isSearchable: boolean("is_searchable").notNull().default(false),
    lang: text("lang").$type<LanguageCode>(),
    source: text("source").$type<SkillSource>().notNull(),
    // LEGACY, and nullable as of 0076 for the same reason as `skill.domain_id`, which
    // this denormalizes. See the long note there.
    domainId: text("domain_id"),
    // gemini-embedding-001 @ 768, L2-normalized client-side. (The older comment here
    // named Vertex text-multilingual-embedding-002; that was stale — the shipped
    // embedder is `apps/ai-service/app/ai/embeddings.py`, and these two provenance
    // columns exist so the next such drift is answerable from the data instead of
    // archaeology.) Nullable until embedded by TAX-4.
    embedding: vector("embedding", { dimensions: 768 }),
    // PROVENANCE — the gap `job_domain_alias` already closed and this table did not.
    // Without them a MOCK hash vector is indistinguishable at rest from a real one and
    // the only recovery is re-embedding the whole corpus. Recording the model turns a
    // mock-vs-real cleanup into a targeted UPDATE, and makes the eventual
    // gemini-embedding-2 migration a query instead of a guess.
    //
    // They backfill NOTHING: the 131 existing vectors cannot be attributed after the
    // fact, so they stay NULL-provenance and the first real run should be preceded by
    // an explicit reset.
    embeddingModel: text("embedding_model"),
    embeddedAt: timestamp("embedded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Domain-scoped ANN filter (ADR-0030); domain_id alone suffices (the HNSW does the
    // vector order, this pre-filters the domain).
    index("skill_alias_domain_id_idx").on(t.domainId),
    // FK-referencing column (Postgres does not auto-index it; the ON DELETE cascade needs it).
    index("skill_alias_skill_id_idx").on(t.skillId),
    // L0 — exact normalized lookup. Plain btree; the query is an equality probe.
    index("skill_alias_text_norm_idx").on(t.textNorm),
    // L2 — fuzzy lookup via pg_trgm `word_similarity`. The extension is already installed
    // (migration 0067 for the domain side), so this is an index, not an extension change.
    index("skill_alias_text_norm_trgm_idx").using("gin", t.textNorm.op("gin_trgm_ops")),
    // Second HNSW cosine index (the §7(a) capacity item) over alias embeddings.
    //
    // DELIBERATELY LEFT NON-PARTIAL AND UNTUNED by 0076. Making it
    // `WHERE is_searchable` today would silently unindex all 131 live rows (they default
    // to false until the normalizer runs), and Postgres only uses a partial index when
    // the query repeats its predicate — so the shipped `canonicalize_skill` would fall
    // back to a sequential scan and return identical results, only slower. The retune
    // belongs in the same change that populates `is_searchable` and updates the query.
    index("skill_alias_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
    // The L0/L2 uniqueness guarantee — the duplicate-alias prevention this table has
    // never had. PARTIAL on `is_searchable` so un-normalized rows (all 131 of them, at
    // migration time) and losing duplicates can coexist with it rather than block it.
    //
    // Migration 0076 adds `NULLS NOT DISTINCT` (PG15) BY HAND, for the third time in this
    // schema and for the same reason: this drizzle version models that clause only on a
    // table CONSTRAINT, never on an INDEX, so the model below is knowingly a subset of
    // what is deployed. Without it a NULL `lang` would make two otherwise-identical
    // aliases count as distinct. See `unresolved_phrase_scope_uq` above and
    // `job_domain_alias_domain_norm_lang_uq` for the same drift, documented at both ends.
    uniqueIndex("skill_alias_skill_norm_lang_uq")
      .on(t.skillId, t.textNorm, t.lang)
      .where(sql`${t.isSearchable}`),
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
    // WHICH VOCABULARY THE PHRASE FAILED TO RESOLVE IN (migration 0070).
    //
    // This table is WIDENED rather than duplicated, and that is the whole design decision.
    // It already owns the atomic count upsert, the pseudonymized-only contract, the
    // open|clustered|resolved lifecycle, the optional clustering embedding and a live
    // writer. A second `unresolved_occupation` table would have to re-earn every one of
    // those and would split the ops queue in two.
    //
    // But the two scopes must NOT share rows: "fitter" is an unresolved SKILL and an
    // unresolved OCCUPATION at the same time, with different follow-up work — one becomes
    // a `skill_alias`, the other a `job_domain_alias`. Merging them would let a resolved
    // skill silently close an open occupation gap.
    //
    // DEFAULT 'skill' keeps every existing row and every existing writer correct with no
    // backfill: everything written before Phase 8 was a skill miss.
    scope: text("scope").$type<UnresolvedPhraseScope>().notNull().default("skill"),
    // Optional embedding for TAX-7 clustering (nullable until clustered).
    embedding: vector("embedding", { dimensions: 768 }),
  },
  (t) => [
    // One row per distinct (scope, phrase, domain, lang) — enables the atomic
    // count-increment upsert. The migration adds NULLS NOT DISTINCT (PG15) by hand — this
    // drizzle version can't model it — so NULL domain/lang phrases still dedupe to one row.
    //
    // `scope` LEADS the index deliberately: the ops queue is always read one scope at a
    // time ("show me unresolved occupations"), so it is the highest-selectivity prefix.
    uniqueIndex("unresolved_phrase_scope_uq").on(t.scope, t.phrase, t.domainId, t.lang),
    index("unresolved_phrase_status_idx").on(t.status),
    check(
      "unresolved_phrase_status_chk",
      sql`${t.status} IN ('open', 'clustered', 'resolved')`,
    ),
    check("unresolved_phrase_scope_chk", sql`${t.scope} IN ('skill', 'occupation')`),
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

