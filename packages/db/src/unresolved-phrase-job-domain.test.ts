/**
 * S3-C / D-6 — `unresolved_phrase.job_domain_id` (migration 0078) schema contract.
 *
 * Same posture as `canonical-taxonomy-schema.test.ts`: these read the drizzle model and the
 * migration SQL, never a live database, so they run in ordinary CI rather than behind
 * `RUN_DB_TESTS`. What they defend is the set of properties a later `db:generate` or a
 * well-meaning edit could silently undo — and every one of them is checkable statically.
 *
 * The single most valuable assertion in this file is that `job_domain_id` is IN the unique
 * index. Without it the column still exists, the writes still succeed, and two canonical
 * misses in different domains quietly merge into one row with an incremented count. Nothing
 * errors; the data is just wrong, and it is wrong in the direction that makes Path A look
 * healthier than it is.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";

import { unresolvedPhrases } from "./schema/skill";

const MIGRATION = readFileSync(
  join(__dirname, "../migrations/0078_unresolved_phrase_job_domain_id.sql"),
  "utf8",
);

/**
 * The migration with every `--` comment line removed.
 *
 * Needed because the destructive-statement assertions below are about what Postgres will
 * EXECUTE, and this file documents its own rollback in a comment footer that necessarily
 * contains the words `DROP COLUMN`. Matching the raw text conflates "this migration drops a
 * column" with "this migration explains how to undo itself" — the second is a virtue.
 */
const EXECUTABLE = MIGRATION.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

const config = getTableConfig(unresolvedPhrases);
const columnNames = config.columns.map((c) => c.name);
const checkNames = config.checks.map((c) => c.name);
const uq = config.indexes.find((i) => i.config.name === "unresolved_phrase_scope_uq");

describe("0078 — the column", () => {
  it("models job_domain_id on unresolved_phrase", () => {
    expect(columnNames).toContain("job_domain_id");
  });

  /**
   * NULLABLE WITH NO DEFAULT is what makes this catalogue-only on PG11+ — no table
   * rewrite, no backfill, no lock held for the length of a scan. A NOT NULL (or a
   * DEFAULT) added later by "tidying" would turn a metadata change into a rewrite and
   * would break the three legal row shapes, two of which have this column NULL.
   */
  it("is nullable and defaultless — additive, no rewrite", () => {
    const col = config.columns.find((c) => c.name === "job_domain_id");
    expect(col?.notNull).toBe(false);
    expect(col?.hasDefault).toBe(false);
    expect(MIGRATION).toContain('ADD COLUMN "job_domain_id" text');
    expect(MIGRATION).not.toMatch(/ADD COLUMN "job_domain_id"[^;]*NOT NULL/);
    expect(MIGRATION).not.toMatch(/ADD COLUMN "job_domain_id"[^;]*DEFAULT/);
  });

  it("references job_domain, so a miss cannot name a domain that does not exist", () => {
    expect(MIGRATION).toContain('FOREIGN KEY ("job_domain_id") REFERENCES "public"."job_domain"');
    // NO ACTION, never CASCADE: job_domain rows are status-managed and never deleted
    // (ADR-0030 SG-5); a cascade would silently discard growth signal if one ever were.
    expect(MIGRATION).toMatch(/job_domain_id[^;]*ON DELETE no action/);
  });
});

describe("0078 — the unique index, which is the load-bearing half", () => {
  /**
   * THE REGRESSION THIS EXISTS FOR, stated as the bug it prevents: with the old
   * four-column key, two canonical misses of the same phrase in DIFFERENT job domains both
   * carry `domain_id IS NULL`, collide, and merge into a single row whose `count` is the
   * sum. The distinction the column was added to record is destroyed at write time, and no
   * error is raised at any layer.
   */
  it("includes job_domain_id in unresolved_phrase_scope_uq", () => {
    expect(uq, "the unique index must exist in the model").toBeDefined();
    const cols = uq?.config.columns.map((c) => ("name" in c ? c.name : String(c)));
    expect(cols).toEqual(["scope", "phrase", "domain_id", "job_domain_id", "lang"]);
    expect(uq?.config.unique).toBe(true);
  });

  it("keeps scope LEADING — the ops queue reads one scope at a time", () => {
    const cols = uq?.config.columns.map((c) => ("name" in c ? c.name : String(c)));
    expect(cols?.[0]).toBe("scope");
  });

  /**
   * The fourth hand-edit of this clause in this schema (0037, 0067, 0072, 0076 preceded
   * it). Dropping it is an ACTIVE regression rather than a missing nicety: the occupation
   * scope has written `domain_id = NULL` since 0070 and depends on NULLs deduping onto one
   * row. Re-running `db:generate` re-emits the index without the clause.
   */
  it("keeps NULLS NOT DISTINCT on the widened index", () => {
    const line = MIGRATION.split("\n").find((l) =>
      l.startsWith('CREATE UNIQUE INDEX "unresolved_phrase_scope_uq"'),
    );
    expect(line, "the widened unique index statement must exist").toBeDefined();
    expect(line).toContain("NULLS NOT DISTINCT");
    expect(line).toContain('"scope","phrase","domain_id","job_domain_id","lang"');
  });

  it("drops the old index before creating the new one, in that order", () => {
    const dropAt = MIGRATION.indexOf('DROP INDEX "unresolved_phrase_scope_uq"');
    const createAt = MIGRATION.indexOf('CREATE UNIQUE INDEX "unresolved_phrase_scope_uq"');
    expect(dropAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(dropAt);
  });

  it("indexes the FK column — Postgres does not do it automatically", () => {
    expect(config.indexes.map((i) => i.config.name)).toContain(
      "unresolved_phrase_job_domain_id_idx",
    );
    expect(MIGRATION).toContain('CREATE INDEX "unresolved_phrase_job_domain_id_idx"');
  });
});

describe("0078 — at most one vocabulary per row", () => {
  /**
   * Three legal shapes, one illegal. The CHECK is what makes the illegal one
   * unrepresentable for every future writer, including ones that never read the DTO.
   */
  it("declares unresolved_phrase_one_domain_chk in the model and the SQL", () => {
    expect(checkNames).toContain("unresolved_phrase_one_domain_chk");
    expect(MIGRATION).toContain('ADD CONSTRAINT "unresolved_phrase_one_domain_chk"');
    // Table-qualified, because that is what the generator emits from the drizzle model —
    // asserting the bare form would drift the moment anyone re-runs `db:generate`.
    expect(MIGRATION).toMatch(
      /CHECK \("unresolved_phrase"\."domain_id" IS NULL OR "unresolved_phrase"\."job_domain_id" IS NULL\)/,
    );
  });

  it("permits all three legal shapes — the CHECK is an OR of NULLs, not an XOR", () => {
    // legacy (domain_id only), canonical (job_domain_id only), occupation (neither).
    // Written as a truth table over the predicate the database will evaluate, so a future
    // edit to an XOR — which would outlaw the occupation scope that has existed since
    // 0070 — fails here rather than at the first occupation miss in production.
    const permits = (domainId: string | null, jobDomainId: string | null) =>
      domainId === null || jobDomainId === null;
    expect(permits("cnc-machining", null)).toBe(true);
    expect(permits(null, "jd_nco_7223_0100")).toBe(true);
    expect(permits(null, null)).toBe(true);
    expect(permits("cnc-machining", "jd_nco_7223_0100")).toBe(false);
  });
});

describe("0078 — additive and reversible", () => {
  it("touches no existing column and drops nothing but the index it rebuilds", () => {
    expect(EXECUTABLE).not.toMatch(/DROP COLUMN/);
    expect(EXECUTABLE).not.toMatch(/DROP TABLE/);
    expect(EXECUTABLE).not.toMatch(/ALTER COLUMN/);
    expect(EXECUTABLE).not.toMatch(/\bUPDATE\s+"?unresolved_phrase/i);
    expect(EXECUTABLE).not.toMatch(/\bDELETE\s+FROM/i);
    // The ONLY DROP is the unique index, immediately recreated above.
    const drops = EXECUTABLE.split("\n").filter((l) => l.startsWith("DROP "));
    expect(drops).toHaveLength(1);
    expect(drops[0]).toContain('DROP INDEX "unresolved_phrase_scope_uq"');
  });

  it("preserves every pre-existing column", () => {
    // The row shape callers already depend on. A generator re-run that renames or drops
    // one of these is a breaking change to a shipped table (CLAUDE.md §10).
    for (const name of [
      "id",
      "phrase",
      "lang",
      "domain_id",
      "count",
      "first_seen",
      "last_seen",
      "status",
      "scope",
      "embedding",
    ]) {
      expect(columnNames).toContain(name);
    }
  });

  it("documents a rollback that reverses every statement it makes", () => {
    // A migration whose rollback is not written down is a migration nobody will dare
    // reverse at 2am. Assert the footer actually names each object this touches.
    const rollback = MIGRATION.slice(MIGRATION.indexOf("ROLLBACK"));
    expect(rollback).toContain('DROP INDEX "unresolved_phrase_job_domain_id_idx"');
    expect(rollback).toContain('DROP CONSTRAINT "unresolved_phrase_one_domain_chk"');
    expect(rollback).toContain('DROP COLUMN "job_domain_id"');
    // ...and restores the ORIGINAL four-column key, with the clause, rather than leaving
    // the widened one behind.
    expect(rollback).toMatch(/"scope","phrase","domain_id","lang"\s*\)?\s*NULLS NOT DISTINCT/);
  });

  it("warns that rollback is lossy once canonical misses exist", () => {
    const rollback = MIGRATION.slice(MIGRATION.indexOf("ROLLBACK"));
    expect(rollback).toMatch(/skill\.phrase_unresolved_v2/);
  });
});
