// Occupation domain: the job_domain catalog + its aliases (generalized profiling,
// migration 0066).

import { sql } from "drizzle-orm";
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
import type { LanguageCode } from "@badabhai/types";

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
    // The ANN index the retrieval query orders on.
    index("job_domain_alias_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
    check("job_domain_alias_source_chk", sql`${t.source} IN ('isco08', 'nco2015', 'rvm')`),
  ],
).enableRLS(); // RLS tracked in the model; FORCE + REVOKE carried by migration 0066

export type JobDomain = typeof jobDomains.$inferSelect;
export type NewJobDomain = typeof jobDomains.$inferInsert;
export type JobDomainAlias = typeof jobDomainAliases.$inferSelect;
export type NewJobDomainAlias = typeof jobDomainAliases.$inferInsert;
