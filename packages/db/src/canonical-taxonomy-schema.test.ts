/**
 * Canonical Domain -> Skill taxonomy (migration 0076) — schema contract tests.
 *
 * These assert the SHAPE, not a live database: they read the drizzle model and the
 * generated SQL. That is deliberate. The properties worth pinning here are the ones a
 * later `db:generate` or a well-meaning edit could silently undo, and every one of them
 * is checkable without Postgres — so they run in normal CI rather than behind
 * `RUN_DB_TESTS`, where the rank-parity suite already sits skipped by default.
 *
 * What they are defending, in order of how expensive the mistake would be:
 *   1. the two hand-edits the generator cannot express and WILL drop if re-run;
 *   2. the privacy posture on `worker_profile_skill`, the first table to join a worker
 *      to a skill vocabulary;
 *   3. the additive-only guarantee — the thing that makes 0076 safe to deploy;
 *   4. the invariants the CHECK constraints encode.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";

import { jobDomainSkills, workerProfileSkills, jobPostingSkills } from "./schema/taxonomy";
import { skills, skillAliases } from "./schema/skill";
import { jobPostings } from "./schema/job";

const MIGRATION = readFileSync(
  join(__dirname, "../migrations/0076_canonical_domain_skill_taxonomy.sql"),
  "utf8",
);

/** Column names for a drizzle table, as they exist in Postgres. */
function columnNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).columns.map((c) => c.name);
}

function checkNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).checks.map((c) => c.name);
}

describe("0076 — the two hand-edits drizzle cannot model", () => {
  /**
   * THE REGRESSION THIS EXISTS FOR: `db:generate` re-emits this index without the clause,
   * nobody notices, and the uniqueness guarantee silently becomes vacuous for the rows that
   * need it most. `lang` is nullable and most aliases carry NULL; Postgres treats every NULL
   * as distinct, so without NULLS NOT DISTINCT two byte-identical aliases of one skill are
   * both admitted and the duplicate-prevention this migration exists to add does nothing.
   *
   * Three earlier migrations (0037, 0067, 0072) hit the same gap. This is the first time it
   * is pinned by a test rather than only by a comment.
   */
  it("keeps NULLS NOT DISTINCT on the skill_alias uniqueness index", () => {
    const line = MIGRATION.split("\n").find((l) =>
      l.startsWith('CREATE UNIQUE INDEX "skill_alias_skill_norm_lang_uq"'),
    );
    expect(line, "the unique index statement must exist").toBeDefined();
    expect(line).toContain("NULLS NOT DISTINCT");
    // PARTIAL is what makes it safe against live data: every shipped row is
    // is_searchable=false, so none participates and a pre-existing duplicate cannot
    // fail the CREATE.
    expect(line).toContain('WHERE "skill_alias"."is_searchable"');
  });

  /**
   * drizzle emits ENABLE only. FORCE + REVOKE are the actual deny-by-default posture
   * (ADR-0004 / TD20) and are hand-appended — so they are exactly what a regenerate drops.
   */
  it("carries FORCE RLS and the four REVOKEs for all three new tables", () => {
    for (const table of ["job_domain_skill", "worker_profile_skill", "job_posting_skill"]) {
      expect(MIGRATION, `${table} ENABLE`).toContain(
        `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`,
      );
      expect(MIGRATION, `${table} FORCE`).toContain(
        `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`,
      );
      for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
        expect(MIGRATION, `${table} REVOKE ${role}`).toContain(
          `REVOKE ALL ON TABLE "${table}" FROM ${role};`,
        );
      }
    }
  });
});

describe("0076 — additive only", () => {
  /**
   * The whole safety argument for deploying this against live `skill_alias` and
   * `job_postings`. If any of these ever appears, the migration stopped being the
   * thing that was reviewed.
   */
  it("drops nothing and rewrites nothing", () => {
    const forbidden = [
      /\bDROP\s+TABLE\b/i,
      /\bDROP\s+COLUMN\b/i,
      /\bDROP\s+CONSTRAINT\b/i,
      /\bDROP\s+INDEX\b/i,
      /\bTRUNCATE\b/i,
      /\bDELETE\s+FROM\b/i,
      /\bUPDATE\s+"/i,
      // ALTER COLUMN ... TYPE forces a rewrite and a long lock.
      /ALTER\s+COLUMN\s+"[^"]+"\s+(SET\s+DATA\s+)?TYPE\b/i,
    ];
    // The rollback recipe in the header legitimately names DROP/SET NOT NULL. Strip
    // comment lines before scanning so documentation cannot fail the test — and so it
    // cannot hide a real statement either.
    const executable = MIGRATION.split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    for (const pattern of forbidden) {
      expect(executable, `must not contain ${pattern}`).not.toMatch(pattern);
    }
  });

  it("only ever RELAXES nullability, never tightens it", () => {
    const executable = MIGRATION.split("\n").filter((l) => !l.trimStart().startsWith("--"));
    const nullability = executable.filter((l) =>
      /ALTER\s+COLUMN\s+"[^"]+"\s+(DROP|SET)\s+NOT NULL/i.test(l),
    );
    expect(nullability).toHaveLength(2);
    for (const line of nullability) expect(line).toMatch(/DROP NOT NULL/);
  });

  /**
   * Every ADD COLUMN must be nullable or constant-defaulted, which is what makes it
   * metadata-only on PG11+ — no table rewrite, no long lock. A `NOT NULL` without a
   * DEFAULT would rewrite the table and fail outright on a non-empty one.
   */
  it("adds only columns that are metadata-only on PG11+", () => {
    const adds = MIGRATION.split("\n").filter((l) => /ADD COLUMN/i.test(l));
    expect(adds.length).toBeGreaterThan(0);
    for (const line of adds) {
      if (/NOT NULL/i.test(line)) {
        expect(line, `NOT NULL add must carry a DEFAULT: ${line}`).toMatch(/DEFAULT/i);
      }
    }
  });
});

describe("skill.domain_id is demoted to legacy, not re-domained", () => {
  /**
   * D1's load-bearing consequence. Re-domaining instead would have been a
   * deprecate-and-recreate under ADR-0030 SG-5, invalidating all 66 live skill ids and
   * every worker/posting value referencing them.
   */
  it("makes both domain_id columns nullable", () => {
    const skillDomain = getTableConfig(skills).columns.find((c) => c.name === "domain_id");
    const aliasDomain = getTableConfig(skillAliases).columns.find((c) => c.name === "domain_id");
    expect(skillDomain?.notNull).toBe(false);
    expect(aliasDomain?.notNull).toBe(false);
  });

  it("keeps the legacy domain-scoped ANN pre-filter index in place", () => {
    // Demoted, not removed: the shipped canonicalizer still reads it.
    const idx = getTableConfig(skillAliases).indexes.map((i) => i.config.name);
    expect(idx).toContain("skill_alias_domain_id_idx");
  });

  /**
   * Leaving the HNSW non-partial is a decision, not an omission. Making it
   * `WHERE is_searchable` today would unindex all 131 live rows (the column defaults
   * false until the normalizer runs) and Postgres only uses a partial index when the
   * query repeats the predicate — so the shipped canonicalizer would fall back to a
   * sequential scan, returning identical results, only slower.
   */
  it("leaves the alias HNSW non-partial until is_searchable is populated", () => {
    const hnsw = getTableConfig(skillAliases).indexes.find(
      (i) => i.config.name === "skill_alias_embedding_hnsw",
    );
    expect(hnsw).toBeDefined();
    expect(hnsw?.config.where).toBeUndefined();
  });
});

describe("skill_alias reaches canonicalization parity", () => {
  it("gains the four columns job_domain_alias already had", () => {
    const cols = columnNames(skillAliases);
    for (const c of ["text_norm", "is_searchable", "embedding_model", "embedded_at"]) {
      expect(cols, `skill_alias.${c}`).toContain(c);
    }
  });

  it("gains the L0 btree and L2 trigram rungs", () => {
    const idx = getTableConfig(skillAliases).indexes.map((i) => i.config.name);
    expect(idx).toContain("skill_alias_text_norm_idx");
    expect(idx).toContain("skill_alias_text_norm_trgm_idx");
  });
});

describe("job_domain_skill — the canonical taxonomy edge", () => {
  it("is keyed on the (domain, skill) pair", () => {
    const pk = getTableConfig(jobDomainSkills).primaryKeys[0];
    expect(pk?.columns.map((c) => c.name)).toEqual(["job_domain_id", "skill_id"]);
  });

  /**
   * Immutable, never-reused id spaces (SG-5): a domain or skill is DEPRECATED, never
   * deleted, so a cascade here could only ever mask a mistake.
   */
  it("does not cascade from the two reference vocabularies", () => {
    for (const fk of getTableConfig(jobDomainSkills).foreignKeys) {
      expect(fk.onDelete ?? "no action").toBe("no action");
    }
  });

  it("encodes its invariants as CHECKs", () => {
    const checks = checkNames(jobDomainSkills);
    expect(checks).toEqual(
      expect.arrayContaining([
        "job_domain_skill_requirement_chk",
        "job_domain_skill_source_chk",
        "job_domain_skill_status_chk",
        "job_domain_skill_relevance_chk",
        "job_domain_skill_confidence_chk",
        // An inheritance pointer only ever exists on an inherited row...
        "job_domain_skill_inherited_from_chk",
        // ...and a domain never inherits from itself.
        "job_domain_skill_no_self_inherit_chk",
      ]),
    );
  });

  /**
   * ONE enum column, not two booleans. Two booleans admit a fourth state with no meaning
   * (both true) and would need a CHECK to forbid it anyway; one column makes the illegal
   * state unrepresentable instead of merely rejected.
   */
  it("expresses required-vs-preferred as a single column", () => {
    const cols = columnNames(jobDomainSkills);
    expect(cols).toContain("default_requirement");
    expect(cols).not.toContain("required_default");
    expect(cols).not.toContain("preferred_default");
  });

  /** Materialized-projection discipline, same as `job_reach.computed_at`. */
  it("records when the offline materializer last wrote each row", () => {
    expect(columnNames(jobDomainSkills)).toContain("computed_at");
  });
});

describe("worker_profile_skill — the authored worker relation", () => {
  it("is keyed on the (profile, skill) pair so extraction is an idempotent upsert", () => {
    const pk = getTableConfig(workerProfileSkills).primaryKeys[0];
    expect(pk?.columns.map((c) => c.name)).toEqual(["worker_profile_id", "skill_id"]);
  });

  /** Deleting a profile must take its skill rows; deprecating a skill must not. */
  it("cascades from the profile but never from the skill vocabulary", () => {
    const byCol = new Map(
      getTableConfig(workerProfileSkills).foreignKeys.map((fk) => [
        fk.reference().columns[0]?.name,
        fk.onDelete ?? "no action",
      ]),
    );
    expect(byCol.get("worker_profile_id")).toBe("cascade");
    expect(byCol.get("skill_id")).toBe("no action");
  });

  /**
   * PRIVACY BOUNDARY (CLAUDE.md §3). `evidence_ref` is an opaque internal id — an
   * `ai_jobs.id`, a turn id — and never a transcript fragment. This row is joined into
   * logs, events, audit records and analytics; a raw utterance here would carry an
   * employer name and a worker name straight past the pseudonymization gateway that
   * exists to stop exactly that.
   *
   * A column type cannot enforce "id, not prose", so what is pinned here is the narrower
   * thing that IS checkable: no free-text column was added under a different name, and
   * the contract is stated where a writer will see it.
   */
  it("exposes exactly one evidence column and documents it as an opaque id", () => {
    const cols = columnNames(workerProfileSkills);
    expect(cols).toContain("evidence_ref");
    for (const leaky of [
      "evidence_text",
      "phrase",
      "quote",
      "transcript",
      "utterance",
      "raw_text",
    ]) {
      expect(cols, `worker_profile_skill must not carry ${leaky}`).not.toContain(leaky);
    }
    const schemaSrc = readFileSync(join(__dirname, "./schema/taxonomy.ts"), "utf8");
    expect(schemaSrc).toContain("PRIVACY BOUNDARY");
    expect(schemaSrc).toMatch(/OPAQUE INTERNAL ID/);
  });

  /** Months, matching `worker_skill.months_bucketed`, so the derivation is a copy. */
  it("stores experience in months rather than years", () => {
    const cols = columnNames(workerProfileSkills);
    expect(cols).toContain("months_experience");
    expect(cols).not.toContain("years_experience");
  });
});

describe("job_posting_skill — what this company asked for", () => {
  it("is keyed on the (posting, skill) pair", () => {
    const pk = getTableConfig(jobPostingSkills).primaryKeys[0];
    expect(pk?.columns.map((c) => c.name)).toEqual(["job_posting_id", "skill_id"]);
  });

  it("cascades from the posting but never from the skill vocabulary", () => {
    const byCol = new Map(
      getTableConfig(jobPostingSkills).foreignKeys.map((fk) => [
        fk.reference().columns[0]?.name,
        fk.onDelete ?? "no action",
      ]),
    );
    expect(byCol.get("job_posting_id")).toBe("cascade");
    expect(byCol.get("skill_id")).toBe("no action");
  });

  /**
   * `requirement` is NOT NULL here while `default_requirement` is defaulted on the
   * taxonomy side, and the asymmetry is the point: the taxonomy may propose, but a
   * posting row only exists because an employer made an explicit choice.
   */
  it("requires an explicit requirement, with no default", () => {
    const col = getTableConfig(jobPostingSkills).columns.find((c) => c.name === "requirement");
    expect(col?.notNull).toBe(true);
    expect(col?.hasDefault).toBe(false);
  });

  it("distinguishes a ticked recommendation from a typed custom skill", () => {
    expect(checkNames(jobPostingSkills)).toContain("job_posting_skill_source_chk");
    expect(MIGRATION).toContain("'domain_default', 'employer_custom'");
  });
});

describe("job_postings gains a canonical domain", () => {
  /**
   * The first domain classifier this table has ever had. Before 0076 it carried no
   * domain, no occupation and no trade column — which is why skill canonicalization
   * anchored every posting to a hardcoded "cnc-machining".
   */
  it("adds a nullable job_domain_id with no backfill", () => {
    const col = getTableConfig(jobPostings).columns.find((c) => c.name === "job_domain_id");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(false);
    expect(col?.hasDefault).toBe(false);
  });

  it("indexes it and points it at the same jd_* space as worker_profiles", () => {
    const idx = getTableConfig(jobPostings).indexes.map((i) => i.config.name);
    expect(idx).toContain("job_postings_job_domain_id_idx");
    expect(MIGRATION).toMatch(
      /job_postings.*FOREIGN KEY \("job_domain_id"\) REFERENCES "public"\."job_domain"/,
    );
  });

  /**
   * The four jsonb skill arrays stay. `reach_skill_ids` is GIN-indexed and load-bearing
   * for per-worker feed reconciliation; the canonical relation lands ALONGSIDE them.
   */
  it("leaves the four legacy skill arrays untouched", () => {
    const cols = columnNames(jobPostings);
    for (const c of ["skill_phrases", "skill_ids", "match_skill_ids", "reach_skill_ids"]) {
      expect(cols, `job_postings.${c} must survive`).toContain(c);
    }
  });
});
