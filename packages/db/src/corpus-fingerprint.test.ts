import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  CORPUS_FINGERPRINT_SQL,
  FINGERPRINT_COMPONENTS,
  PRODUCTION_RETRIEVAL_SEMANTICS,
  describeFingerprintDrift,
  fingerprintDiff,
  fingerprintsMatch,
  reachableAliasCount,
  retrievalSemanticsFromSql,
  toFingerprint,
  type CorpusFingerprint,
} from "./corpus-fingerprint";
import { CANONICAL_RETRIEVAL_SQL } from "./taxonomy-retrieval-eval";

const REPO = join(__dirname, "..", "..", "..");
const REPOSITORY_TS = join(REPO, "apps", "api", "src", "skills", "skills.repository.ts");

const base: CorpusFingerprint = {
  skill_alias: "a",
  skill: "b",
  job_domain_skill: "c",
  job_domain: "d",
  job_domain_alias: "e",
  counts: {
    skill_alias_rows: 328,
    skill_alias_normalized: 328,
    skill_alias_searchable: 197,
    skill_alias_embedded: 295,
    skills_total: 146,
    skills_active: 33,
    job_domain_skill_active_edges: 238,
    job_domain_alias_rows: 9121,
    job_domain_alias_searchable: 0,
    job_domain_alias_embedded: 0,
  },
};

describe("fingerprint comparison", () => {
  it("matches an identical fingerprint", () => {
    expect(fingerprintsMatch(base, { ...base })).toBe(true);
    expect(fingerprintDiff(base, { ...base })).toEqual([]);
  });

  it("detects a change in each component independently", () => {
    for (const c of FINGERPRINT_COMPONENTS) {
      expect(fingerprintDiff(base, { ...base, [c]: "moved" })).toEqual([c]);
    }
  });

  it("treats a missing fingerprint as maximally different, never as a match", () => {
    // Fail closed. A record that cannot say what it measured has not proved anything.
    expect(fingerprintsMatch(base, null)).toBe(false);
    expect(fingerprintsMatch(null, base)).toBe(false);
    expect(fingerprintsMatch(null, null)).toBe(false);
    expect(fingerprintDiff(undefined, base)).toEqual([...FINGERPRINT_COMPONENTS]);
  });

  it("ignores COUNTS when comparing identity", () => {
    // Counts are diagnostics for a human. Equal digests imply equal counts, so comparing
    // both would report one mismatch twice and invite a "counts differ but hashes match"
    // contradiction that cannot actually occur.
    const sameDigestsDifferentCounts = { ...base, counts: { ...base.counts, skills_active: 999 } };
    expect(fingerprintDiff(base, sameDigestsDifferentCounts)).toEqual([]);
  });

  it("names what moved, in words an operator can act on", () => {
    expect(describeFingerprintDrift([])).toBe("corpus fingerprint matches");
    expect(describeFingerprintDrift(["skill_alias"])).toMatch(/searchability/);
    expect(describeFingerprintDrift(["job_domain_alias"])).toMatch(/domain alias/);
  });
});

describe("the fingerprint SQL covers every way retrieval can change", () => {
  const sql = new PgDialect().sqlToQuery(CORPUS_FINGERPRINT_SQL).sql;

  // The old signal was `max(embedded_at) FROM skill_alias`. Each row below is a corpus
  // change that moves what retrieval returns while leaving that timestamp untouched.
  it.each([
    ["text_norm — the Phase 8 write, 131 rows, no embedded_at change", /"text_norm"/],
    ["is_searchable — the NEXT mutation, 129 rows, no embedded_at change", /"is_searchable"/],
    ["alias add/remove — a DELETE cannot raise a max()", /FROM "skill_alias"/],
    ["skill status — retrieval filters s.status", /FROM "skill"/],
    ["domain->skill edges — the canonical path joins through them", /FROM "job_domain_skill"/],
    ["domain status/selectable", /FROM "job_domain"/],
    ["domain aliases — resolved BEFORE skill retrieval", /FROM "job_domain_alias"/],
    ["embedding model/provenance", /"embedding_model"/],
    ["the vectors themselves", /md5\("embedding"::text\)/],
  ])("covers %s", (_why, pattern) => {
    expect(sql).toMatch(pattern);
  });

  it("uses an explicit chr(1) separator, never a literal control character", () => {
    // Second occurrence of this bug in this package. A literal U+0001 between two quotes
    // reads as `''` in every editor and diff, and silently changes the digest.
    expect(sql).toMatch(/chr\(1\)/);
    expect([...sql].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20 && !"\n\r\t".includes(ch))).toBe(false);
  });

  it("distinguishes NULL from a literal, and survives an empty table", () => {
    expect(sql).toMatch(/coalesce\("text_norm", '~'\)/);
    // coalesce(string_agg(...), '') — md5 of NULL is NULL, which would make an empty table
    // indistinguishable from a missing fingerprint.
    expect(sql).toMatch(/md5\(coalesce\(string_agg/);
  });

  it("orders every aggregate, so the digest is not row-order dependent", () => {
    const aggregates = sql.match(/string_agg\(/g) ?? [];
    const ordered = sql.match(/ORDER BY/g) ?? [];
    expect(aggregates.length).toBeGreaterThanOrEqual(5);
    expect(ordered.length).toBeGreaterThanOrEqual(aggregates.length);
  });
});

describe("toFingerprint", () => {
  it("coerces a raw driver row, defaulting missing values rather than throwing", () => {
    const fp = toFingerprint({ skill_alias: "x", skill_alias_rows: "328" });
    expect(fp.skill_alias).toBe("x");
    expect(fp.counts.skill_alias_rows).toBe(328);
    expect(fp.skill).toBe("");
    expect(fp.counts.skills_active).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// THE PIN THAT KEEPS THE PROMOTION GATE HONEST
// ─────────────────────────────────────────────────────────────────────────────────────

/** The SQL template belonging to one named definition, isolated from its neighbours. */
function sqlBodyOf(file: string, anchor: string): string {
  const src = readFileSync(file, "utf8");
  const at = src.indexOf(anchor);
  expect(at, `anchor not found: ${anchor}`).toBeGreaterThan(-1);
  expect(src.indexOf(anchor, at + 1), `anchor is ambiguous: ${anchor}`).toBe(-1);
  const open = src.indexOf("`", at);
  const close = src.indexOf("`", open + 1);
  return src.slice(open + 1, close);
}

describe("PRODUCTION_RETRIEVAL_SEMANTICS is pinned to the production SQL", () => {
  const sites = [
    { name: "canonicalAliasRows", sql: () => sqlBodyOf(REPOSITORY_TS, "private canonicalAliasRows(") },
    { name: "legacyAliasRows", sql: () => sqlBodyOf(REPOSITORY_TS, "private legacyAliasRows(") },
  ];

  it("declares requiresSearchable=false, and the SQL agrees", () => {
    // THE COUPLING. `FULLY_EMBEDDED` counts an alias as reachable using these flags. If
    // someone adds `AND sa.is_searchable` to the repository without flipping the flag, the
    // gate would keep judging by the old rule and let a skill through that production can no
    // longer return. This test makes that impossible: the SQL change fails here until the
    // flag moves, and moving the flag tightens the gate in the same commit.
    expect(PRODUCTION_RETRIEVAL_SEMANTICS.requiresSearchable).toBe(false);
    for (const s of sites) {
      expect(retrievalSemanticsFromSql(s.sql()).requiresSearchable, s.name).toBe(false);
    }
    expect(retrievalSemanticsFromSql(CANONICAL_RETRIEVAL_SQL).requiresSearchable).toBe(false);
  });

  it("declares the predicates production DOES apply", () => {
    expect(PRODUCTION_RETRIEVAL_SEMANTICS.requiresEmbedding).toBe(true);
    expect(PRODUCTION_RETRIEVAL_SEMANTICS.requiresActiveSkill).toBe(true);
    for (const s of sites) {
      const parsed = retrievalSemanticsFromSql(s.sql());
      expect(parsed.requiresEmbedding, s.name).toBe(true);
      expect(parsed.requiresActiveSkill, s.name).toBe(true);
    }
  });

  it("reads the intended statement at each site, so the pin cannot pass by mis-parsing", () => {
    // Anti-vacuity: every assertion above would also pass on an empty string.
    expect(sqlBodyOf(REPOSITORY_TS, "private canonicalAliasRows(")).toMatch(/job_domain_skill/);
    expect(sqlBodyOf(REPOSITORY_TS, "private legacyAliasRows(")).toMatch(/sa\.domain_id/);
  });

  it("the parser actually detects the predicate when it IS present", () => {
    // Otherwise the pin above passes because the parser never returns true for anything.
    const withPredicate = "SELECT sa.skill_id FROM skill_alias sa WHERE sa.embedding IS NOT NULL AND sa.is_searchable";
    expect(retrievalSemanticsFromSql(withPredicate).requiresSearchable).toBe(true);
  });
});

describe("reachableAliasCount", () => {
  const embedded = { hasEmbedding: true, isSearchable: false };
  const embeddedSearchable = { hasEmbedding: true, isSearchable: true };
  const unembedded = { hasEmbedding: false, isSearchable: true };

  it("counts embedded aliases today, regardless of is_searchable", () => {
    // Measured: all 98 active-catalogue aliases have is_searchable=false and are fully
    // retrievable — `fitting` and `gauge` both return rank 1 at cosine 1.0000 through
    // production's own statement. A gate demanding the flag today would be wrong.
    expect(reachableAliasCount([embedded, embedded, unembedded])).toBe(2);
  });

  it("requires is_searchable ONCE the semantics say production filters on it", () => {
    const future = { ...PRODUCTION_RETRIEVAL_SEMANTICS, requiresSearchable: true };
    expect(reachableAliasCount([embedded, embedded, unembedded], future)).toBe(0);
    expect(reachableAliasCount([embeddedSearchable, embedded], future)).toBe(1);
  });

  it("returns 0 for a skill with no aliases", () => {
    expect(reachableAliasCount([])).toBe(0);
  });
});
