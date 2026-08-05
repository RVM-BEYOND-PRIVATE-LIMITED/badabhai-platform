/**
 * Occupation domain — the generalized-profiling JOB DOMAIN catalog and its aliases.
 */
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  pgTable,
  uuid,
  text,
  integer,
  smallint,
  boolean,
  timestamp,
  vector,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import type {
  LanguageCode,
} from "@badabhai/types";

// ===========================================================================
// Generalized profiling — the JOB DOMAIN catalog (migration 0066).
// ---------------------------------------------------------------------------
// WHAT THIS IS FOR. Chat profiling no longer picks questions from a hardcoded
// Python bank keyed to 7 role families — the LLM conducts the interview for
// whatever trade the worker actually does. That leaves one problem: at the end we
// still have to place the worker in a domain WE SUPPORT, and 13 hardcoded roles
// cannot express a cook, a tailor, a driver, or a warehouse picker. This catalog
// is that vocabulary, seeded from published occupation standards rather than
// invented in TypeScript.
//
// NAMING — READ BEFORE ADDING A COLUMN. The repo already carries TWO meanings for
// "domainId": occupation domains (`dom_*`, @badabhai/taxonomy DOMAINS) and skill
// domains (bare slugs like `cnc-machining`, SKILL_DOMAINS). This table introduces
// a THIRD id space and deliberately does NOT reuse the name: every column, DTO
// field and query here says `job_domain_id`, and every id is prefixed `jd_`. A
// grep for job_domain_id must never return a skill domain, and vice versa.
//
// WHY NOT RAW NCO/ISCO CODES AS THE PK. ISCO unit `7223` and NCO `7223.0100`
// collide in text space, so a code PK needs a composite (scheme, code) key — which
// would propagate a two-column FK into worker_profiles. Ids are instead MINTED and
// DERIVED from the source (`jd_isco_7223`, `jd_nco_7223_0100`, `jd_rvm_*`), which
// keeps the seed idempotent, the id readable, and leaves room for rows the
// standards do not have (NCO-2015 predates quick commerce; `ind_quick_commerce`
// already exists in the taxonomy).
//
// IMMUTABLE + APPEND-ONLY, same discipline as `skill` (SG-5): a job_domain_id is
// never renamed or reused. Change is a version bump + a status transition +
// `replaced_by`, re-tagged OFFLINE — never rewritten on the live path.
//
// PRIVACY (invariant #2): PII-FREE by construction. Published occupation titles,
// definitions, codes and vectors over those titles. Nothing worker-derived is ever
// written here — the worker side of the match lands on worker_profiles.
// ===========================================================================

/** Where a catalog row came from. `rvm` = minted by us for a domain the published
 *  standards do not cover (and therefore the ONLY source allowed to omit a code). */
export type JobDomainSource = "isco08" | "nco2015" | "rvm";
export type JobDomainStatus = "active" | "provisional" | "deprecated";

/**
 * How `worker_profiles.job_domain_id` was arrived at — recorded on EVERY path,
 * including the ones that placed nobody.
 *
 * `matched_auto`            top candidate cleared the confident floor by a clear
 *                           margin, so no LLM call was spent confirming it.
 * `matched_llm`             the model chose from the retrieved shortlist and the id
 *                           re-validated against the catalog.
 * `unmatched_below_floor`   nothing cleared the shortlist floor. No LLM was called —
 *                           there was nothing worth confirming.
 * `unmatched_llm_declined`  the model saw the shortlist and correctly said none fit.
 * `unmatched_degraded`      embedding blocked, seam down, or the call failed.
 *
 * An unmatched profile is a NORMAL outcome, never an error: the resume is still built
 * from the existing path. A wrong domain is worse than no domain, so a match is never
 * forced to avoid a NULL.
 */
export type JobDomainMatchStatus =
  | "matched_auto"
  | "matched_llm"
  | "unmatched_below_floor"
  | "unmatched_llm_declined"
  | "unmatched_degraded";

export const jobDomains = pgTable(
  "job_domain",
  {
    jobDomainId: text("job_domain_id").primaryKey(),
    labelEn: text("label_en").notNull(),
    labelHi: text("label_hi"),
    descriptionEn: text("description_en"),
    source: text("source").$type<JobDomainSource>().notNull(),
    // The published code in its own scheme: ISCO "7223", NCO "7223.0100". NULL only
    // for `rvm` rows (CHECK below). Not the PK — see the header.
    sourceCode: text("source_code"),
    // 1..5. ISCO-08 is four levels (major/sub-major/minor/unit); NCO-2015 aligns to
    // ISCO on the leading four digits and adds an India-specific suffix, which is
    // the 5th. Levels 1-3 are BUCKETS ("Craft and Related Trades Workers") — real
    // navigation, but not a job anyone holds.
    level: smallint("level").notNull(),
    parentJobDomainId: text("parent_job_domain_id").references(
      (): AnyPgColumn => jobDomains.jobDomainId,
    ),
    // DENORMALIZED ancestors, same move `skill_alias.domain_id` makes: turns
    // "restrict retrieval to this branch" into a plain WHERE instead of a recursive
    // CTE on a request path. Plain text, not char(n) — char pads with spaces, which
    // silently breaks equality against a trimmed value.
    iscoMajorCode: text("isco_major_code"),
    iscoUnitCode: text("isco_unit_code"),
    // The two INTERMEDIATE ISCO levels, DERIVED from `isco_unit_code` rather than stored
    // independently (migration 0067). ISCO-08 codes are strictly positional — unit `7223`
    // is minor `722` is sub-major `72` — so these can never disagree with the unit code,
    // and GENERATED ALWAYS makes that structural instead of a seeder promise.
    //
    // WHY THEY EXIST: family bindings resolve most-specific-first across five levels
    // (unit -> minor -> sub-major -> major -> universal). Without these two columns the
    // middle two levels need `left(isco_unit_code, 3)` in the predicate, which is not
    // sargable and cannot use an index.
    iscoMinorCode: text("isco_minor_code").generatedAlwaysAs(
      (): SQL => sql`left(${jobDomains.iscoUnitCode}, 3)`,
    ),
    iscoSubmajorCode: text("isco_submajor_code").generatedAlwaysAs(
      (): SQL => sql`left(${jobDomains.iscoUnitCode}, 2)`,
    ),
    // ISCO-08 skill level 1..4. DESCRIPTIVE ONLY — never an input to ranking
    // (invariant #4: rank is deterministic and lives in the match engine).
    skillLevel: smallint("skill_level"),
    // `ind_*` by convention (@badabhai/taxonomy INDUSTRIES). No FK: INDUSTRIES is a
    // TypeScript constant, not a table. The corpus validator enforces membership.
    industryId: text("industry_id"),
    // THE CROSSWALK to the legacy 13-role space, for the ~dozens of domains that map
    // onto a role the match engine already understands. Nullable and mostly NULL by
    // design — no FK for the same reason as industryId. Nothing reads this yet; it is
    // how `job_domain -> role_* -> mskill_*` gets wired later WITHOUT minting a
    // 4,000-key map, reusing the two exhaustive maps that already exist.
    canonicalRoleId: text("canonical_role_id"),
    // May a worker profile point AT this row? Set at seed time for leaves, so it is
    // derived rather than curated. Retrieval filters on it: a bucket row must never
    // be returned as somebody's occupation.
    selectable: boolean("selectable").notNull().default(false),
    status: text("status").$type<JobDomainStatus>().notNull().default("active"),
    version: integer("version").notNull().default(1),
    replacedBy: text("replaced_by").references((): AnyPgColumn => jobDomains.jobDomainId),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One row per published code per scheme. Minted (`rvm`) rows carry NULL and are
    // exempt for free: Postgres treats NULLs as DISTINCT, the same property
    // `worker_profiles_ai_job_id_uq` already relies on — so no partial index needed.
    uniqueIndex("job_domain_source_code_uq").on(t.source, t.sourceCode),
    // FK-referencing column; Postgres does not auto-index it.
    index("job_domain_parent_idx").on(t.parentJobDomainId),
    // The retrieval pre-filter: "active, selectable rows only".
    index("job_domain_selectable_idx").on(t.selectable, t.status),
    // Branch-scoped retrieval without a recursive CTE.
    index("job_domain_isco_unit_idx").on(t.iscoUnitCode),
    // The two intermediate rungs of the family-binding fallback chain (migration 0067).
    index("job_domain_isco_minor_idx").on(t.iscoMinorCode),
    index("job_domain_isco_submajor_idx").on(t.iscoSubmajorCode),
    check("job_domain_source_chk", sql`${t.source} IN ('isco08', 'nco2015', 'rvm')`),
    check("job_domain_status_chk", sql`${t.status} IN ('active', 'provisional', 'deprecated')`),
    check("job_domain_level_chk", sql`${t.level} BETWEEN 1 AND 5`),
    check(
      "job_domain_skill_level_chk",
      sql`${t.skillLevel} IS NULL OR ${t.skillLevel} BETWEEN 1 AND 4`,
    ),
    // A bucket is not an occupation. Enforced rather than trusted, because a
    // selectable bucket would let the matcher place a worker in
    // "Craft and Related Trades Workers" and call it a job.
    check("job_domain_selectable_leaf_chk", sql`${t.selectable} = false OR ${t.level} >= 4`),
    // Only a MINTED row may lack a published code — otherwise a scrape gap would
    // enter the catalog as a codeless, unverifiable row.
    check(
      "job_domain_source_code_chk",
      sql`${t.source} = 'rvm' OR ${t.sourceCode} IS NOT NULL`,
    ),
    // Crosswalk discipline, mirroring skill_replaced_by_chk.
    check(
      "job_domain_replaced_by_chk",
      sql`${t.replacedBy} IS NULL OR ${t.status} = 'deprecated'`,
    ),
    check(
      "job_domain_no_self_parent_chk",
      sql`${t.parentJobDomainId} IS NULL OR ${t.parentJobDomainId} <> ${t.jobDomainId}`,
    ),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0066

// Alias variants of a job domain — official title, the standards' own "occupations
// classified here" examples, and Hinglish/vernacular forms a worker would actually
// say ("kharad operator", "silai wala").
//
// WE EMBED THE ALIASES, NOT THE CANONICAL LABEL — the same choice ADR-0030 made for
// skills, and for the same reason: a worker describes their trade in their own words,
// and the official title ("Metal Working Machine Tool Setters and Operators") is the
// one phrasing nobody uses. Matching a summary against the alias set is what makes
// retrieval work at all.
export const jobDomainAliases = pgTable(
  "job_domain_alias",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobDomainId: text("job_domain_id")
      .notNull()
      .references(() => jobDomains.jobDomainId, { onDelete: "cascade" }),
    text: text("text").notNull(),
    // THE L0/L2 SEARCH KEY (migration 0067). `normalizeOccupationText` applied to `text`:
    // NFKC, lowercased, punctuation stripped, Indian occupational particles removed. Both
    // the seeder AND the query path call that one function, which is the whole point — two
    // normalizers that drift make exact-match retrieval silently return nothing.
    //
    // NOT a GENERATED column, deliberately: the particle list is DATA
    // (`@badabhai/profiling-lexicon` `data/particles.json`) and changes without a deploy,
    // a generated column would force a full table rewrite on every rule change, and
    // Postgres forbids a non-IMMUTABLE expression there anyway.
    //
    // NULL means "not normalized yet" and is the runner's resumability predicate
    // (`WHERE text_norm IS NULL`). It is never used to mean "excluded" — that is
    // `is_searchable`'s job, precisely so the runner terminates.
    textNorm: text("text_norm"),
    // IS THIS ROW PART OF THE RETRIEVAL SURFACE? Three independent reasons it may not be,
    // all of them the same question, all set by `pnpm db:normalize:aliases`:
    //   1. the domain is not `selectable AND status='active'`;
    //   2. the domain is an ISCO unit group SHADOWED by selectable NCO children — 370 of
    //      the 436 units. Both granularities are seeded and both are `selectable`, so
    //      without this the shortlist mixes "Welders and Flame Cutters" with 44 specific
    //      NCO welding occupations. `selectable` itself is left ALONE: it is referenced by
    //      a CHECK and by written `worker_profiles.job_domain_id` values;
    //   3. this alias is not the canonical representative of its `text_norm` within the
    //      domain. 70 alias pairs differ only in punctuation ("Signaller (railway)" vs
    //      "Signaller, railway") and collapse onto one `text_norm`.
    //
    // Reason 3 is why the 0068 unique index is PARTIAL on this column instead of covering
    // the table: a losing duplicate keeps its row, its stable id and its paid embedding,
    // and simply stops being retrievable. Nothing is deleted (CLAUDE.md §10).
    //
    // Constant DEFAULT false => metadata-only on PG11+, no table rewrite. Same argument
    // `skill.kind` already makes.
    isSearchable: boolean("is_searchable").notNull().default(false),
    lang: text("lang").$type<LanguageCode>(),
    source: text("source").$type<JobDomainSource>().notNull(),
    // 768-dim to match the existing corpus (gemini-embedding-001 @ 768, L2-normalized
    // client-side). Nullable until the backfill runs — `pnpm db:embed:domains` fills
    // NULLs only, so it is resumable and re-runnable.
    embedding: vector("embedding", { dimensions: 768 }),
    // PROVENANCE, and the reason these two columns exist at all: skill_alias has no
    // equivalent, so a MOCK hash vector is indistinguishable at rest from a real one
    // and the only recovery is re-embedding everything. Recording the model makes a
    // mock-vs-real cleanup a targeted UPDATE instead of a full reset.
    embeddingModel: text("embedding_model"),
    embeddedAt: timestamp("embedded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // FK-referencing column; the ON DELETE cascade needs it.
    index("job_domain_alias_job_domain_id_idx").on(t.jobDomainId),
    // L0 — exact normalized lookup. Plain btree; the query is an equality probe.
    index("job_domain_alias_text_norm_idx").on(t.textNorm),
    // L2 — fuzzy lookup via pg_trgm `word_similarity`. The extension is installed by
    // migration 0067 (hand-prepended `CREATE EXTENSION`, the 0001 pgvector precedent).
    index("job_domain_alias_text_norm_trgm_idx").using("gin", t.textNorm.op("gin_trgm_ops")),
    // L3 — the ANN index the retrieval query orders on.
    //
    // PARTIAL + RETUNED in migration 0068 (`m=16, ef_construction=128, WHERE is_searchable`).
    // Doing it in Phase 1 is close to free: the index is empty of real vectors today, so
    // the rebuild costs nothing, whereas retuning after the Phase 2 backfill would mean
    // re-indexing a paid-for corpus.
    //
    // The partial predicate is load-bearing for the QUERY, not just for size: Postgres only
    // uses a partial index when the query carries a matching predicate, so
    // `nearestDomains` MUST say `WHERE is_searchable` or it silently falls back to a
    // sequential scan and returns identical rows, only slower.
    index("job_domain_alias_embedding_hnsw")
      .using("hnsw", t.embedding.op("vector_cosine_ops"))
      .with({ m: 16, ef_construction: 128 })
      .where(sql`${t.isSearchable}`),
    // The L0/L2 uniqueness guarantee, PARTIAL so that un-normalized and duplicate rows can
    // coexist with it.
    //
    // Migration 0067 adds `NULLS NOT DISTINCT` (PG15) BY HAND — this drizzle version can
    // model that clause only on a table CONSTRAINT, never on an INDEX, so the model below
    // is knowingly a subset of what is deployed. Same drift, same reason, and the same
    // both-ends documentation as `unresolved_phrase_uq` (see skill.ts). Without the clause
    // a NULL `lang` would make two otherwise-identical aliases count as distinct.
    uniqueIndex("job_domain_alias_domain_norm_lang_uq")
      .on(t.jobDomainId, t.textNorm, t.lang)
      .where(sql`${t.isSearchable}`),
    check("job_domain_alias_source_chk", sql`${t.source} IN ('isco08', 'nco2015', 'rvm')`),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0066

// ===========================================================================
// Matching V1 — the SUPPLY side (migration 0053).
// ---------------------------------------------------------------------------
// `worker_skill` is the per-worker matchable inventory the reach materializer scans;
// `worker_industry_tenure` is the per-industry calendar tenure the rank rule reads.
// Both are DERIVED, rebuildable projections — never a system of record for anything a
// worker told us (that stays in `worker_profiles`).
//
// PRIVACY (invariant #2): PII-FREE by construction. The ONLY columns are opaque UUIDs
// (`worker_id` → `workers`, where PII already lives, RLS-locked), closed-vocabulary
// skill/industry ids, integers, dates and a source enum. There is NO name, phone,
// address, or EMPLOYER NAME column — worker history is COARSE at launch precisely so
// that no per-job stint (and therefore no employer identity) is stored here. Nothing in
// these tables may be copied into an event payload, `ai_jobs`, `audit_logs`, or a log.
//
// DPDP ERASURE (ADR-0026 Phase 5 / ADR-0031): both `worker_id` FKs are ON DELETE
// CASCADE, so the existing single-statement hard delete
// (`WorkersRepository.hardDelete` → DELETE FROM workers WHERE id = $1) erases these
// rows atomically with the worker. That path enumerates NO table names, so no deletion
// code changes — the cascade IS the coverage. Do not switch either FK to SET NULL.
//
// Invariant #4: these are DETERMINISTIC, rule-derived rows (the D2 coarse backfill and
// the interview writer). No LLM ranks, scores, or decides anything here.
// ===========================================================================

