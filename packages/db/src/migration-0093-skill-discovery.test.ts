/**
 * Migration 0093 — THE PROPERTIES THAT KEEP A DISCOVERED PHRASE OUT OF THE MATCHING VOCABULARY.
 *
 * 0093 creates four EMPTY tables and touches nothing existing: no column is added, dropped,
 * renamed or re-typed on any shipped table, no constraint is relaxed, no index is rebuilt. So the
 * interesting assertions are not "does it create the right columns" — the schema file and
 * `drizzle-kit` settle that, and the CI "Migration drift" check compares the two. The interesting
 * assertions are about the CONSTRAINTS, because those are the half of the safety story that lives
 * in the database rather than in TypeScript.
 *
 * ===========================================================================
 * WHY THE DATABASE HAS TO CARRY ANY OF THIS AT ALL
 * ===========================================================================
 * The review layer's guarantees are enforced in three places, and they are not redundant — each
 * covers a way the others can be bypassed:
 *
 *   THE PIPE   `AdminSkillDecisionSchema` refuses a malformed decision with a 400 that names the
 *              field. It sees only what arrives over HTTP.
 *   THE CODE   `canTransition` refuses an illegal rung. It is the ONLY enforcement of the ladder
 *              — no CHECK below stops `pending -> approved_map` — and it protects nothing against
 *              a `psql` session.
 *   THE SCHEMA the CHECKs asserted here. They are what still holds when somebody runs an UPDATE
 *              by hand, when a future service forgets a rule, or when a migration in six months
 *              adds a writer nobody reviewed.
 *
 * A row that satisfies all three is a decision. A row that satisfies only the first two is a
 * claim, and the last line of defence is the only one that cannot be forgotten by a caller.
 *
 * ===========================================================================
 * WHAT THIS FILE DOES NOT CLAIM
 * ===========================================================================
 * That 0093 has been APPLIED. It has not — verified read-only against the live database on
 * 2026-08-27: `skill_candidate` and its three siblings are absent, and the applied migration head
 * is 0092. These assertions are about the committed SQL, which is what a reviewer reads and what
 * `pnpm db:migrate` will eventually run. Nothing here connects to a database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const TAG = "0093_skill_discovery_candidate_layer";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");

/**
 * The STATEMENTS, with comments stripped.
 *
 * 0093's header is ~100 lines and QUOTES ITS OWN SQL — it names every CHECK it adds and explains
 * the SKILL_ORPHAN argument in prose that contains the words `job_domain_skill` and
 * `approved_job_domain_ids`. Matching against the raw text would read those sentences as
 * statements, which is how a shape assertion quietly turns into a prose assertion and then fails
 * on an edit to a comment. Same first step `parseMigration` takes.
 */
const DDL = RAW.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

const TABLES = [
  "skill_discovery_run",
  "skill_candidate",
  "skill_candidate_source",
  "skill_candidate_match",
] as const;

/** Collapse whitespace so an assertion is about the SQL and not about how it was wrapped. */
const flat = (s: string): string => s.replace(/\s+/g, " ");
const FLAT = flat(DDL);

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("reads a migration that exists and is not empty", () => {
    expect(RAW.length).toBeGreaterThan(1000);
    expect(FLAT).toContain('CREATE TABLE "skill_candidate"');
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    // The header contains the sentence "skill_candidate_reviewed_chk a human decision names the
    // human, the moment AND the reason". If comments were not stripped, the CHECK assertions
    // below would pass on that sentence alone — with the constraint deleted.
    expect(RAW).toContain("skill_candidate_reviewed_chk          a human decision names");
    expect(DDL).not.toContain("a human decision names");
  });
});

describe("0093 is additive — nothing existing is touched", () => {
  it("creates four tables and alters no shipped one", () => {
    for (const t of TABLES) expect(FLAT).toContain(`CREATE TABLE "${t}"`);
    // Every ALTER in the file targets one of the four. An ALTER against `skill`, `skill_alias` or
    // `job_domain_skill` would make this migration a corpus change wearing a staging-layer name.
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1] as string);
    expect(altered.length).toBeGreaterThan(0);
    expect([...new Set(altered)].sort()).toEqual([...TABLES].sort());
  });

  it("drops nothing and truncates nothing", () => {
    for (const verb of ["DROP TABLE", "DROP COLUMN", "DROP CONSTRAINT", "TRUNCATE"]) {
      expect(FLAT.toUpperCase()).not.toContain(verb);
    }
  });

  it("holds the only 0093 slot in the journal, contiguous with 0092", () => {
    const entry = JOURNAL.entries.find((e) => e.tag === TAG);
    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(93);
    expect(JOURNAL.entries.filter((e) => e.idx === 93)).toHaveLength(1);
    // Contiguity: the entry before it is 0092, so no branch has claimed the slot in between.
    const sorted = [...JOURNAL.entries].sort((a, b) => a.idx - b.idx);
    const at = sorted.findIndex((e) => e.tag === TAG);
    expect(sorted[at - 1]?.idx).toBe(92);
  });
});

describe("the match-skill wall, at BOTH ends", () => {
  // `mskill_*` is a closed, CEO-ratified 18-member vocabulary the deterministic match engine
  // consumes. A discovered phrase that could resolve onto one — or even be OFFERED as one to a
  // reviewer — would make a mined alias an author of ranking vocabulary. CLAUDE.md §3 forbids it,
  // the pipe refuses it, `validateCandidate` refuses it, and these two are what still refuse it
  // when somebody writes the row by hand.

  it("a candidate may not RESOLVE onto a match skill", () => {
    expect(FLAT).toContain('CONSTRAINT "skill_candidate_not_match_skill_chk"');
    expect(FLAT).toMatch(/skill_candidate_not_match_skill_chk" CHECK[^;]*resulting_skill_id[^;]*NOT LIKE/i);
  });

  it("a match skill may not even be OFFERED as evidence", () => {
    // The subtler half. Refusing the resolution but allowing the MATCH would still put
    // `mskill_quality_inspector` on a review screen as a mapping option — and this repository has
    // measured that exact false match (`visual_defect_identification -> quality_inspector`).
    expect(FLAT).toContain('CONSTRAINT "skill_candidate_match_not_match_skill_chk"');
    expect(FLAT).toMatch(
      /skill_candidate_match_not_match_skill_chk" CHECK[^;]*skill_id[^;]*NOT LIKE/i,
    );
  });

  it("both spell the prefix with an ESCAPED underscore", () => {
    // `LIKE 'mskill_%'` treats `_` as a single-character wildcard, so it would also match
    // `mskillX...` and — far worse — read as a looser pattern than it is. The escape is what makes
    // the constraint mean the prefix it appears to mean.
    const matches = [...FLAT.matchAll(/NOT LIKE '([^']+)'/g)].map((m) => m[1] as string);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    for (const p of matches) expect(p).toBe("mskill\\_%");
  });
});

describe("the audit wall, in both directions", () => {
  it("a human-decided row must name the human, the moment AND the reason", () => {
    // All three together or the row is refused. That is what makes the audit trail a property of
    // the schema rather than a promise made by whichever service wrote the row.
    expect(FLAT).toContain('CONSTRAINT "skill_candidate_reviewed_chk"');
    const chk = FLAT.match(/"skill_candidate_reviewed_chk" CHECK \(([^;]*?)\)\s*(?:,|\))/)?.[1] ?? "";
    expect(chk).toBeTruthy();
    for (const col of ["reviewer_admin_id", "reviewed_at", "review_reason"]) {
      expect(chk, col).toContain(col);
    }
    for (const status of ["approved_create", "approved_map", "approved_merge", "rejected", "deferred"]) {
      expect(chk, status).toContain(status);
    }
  });

  it("a machine-written row may NOT carry a reviewer", () => {
    // The inverse, and it is the one that stops a forged approval looking like a real one: a
    // `pending` row with a reviewer_admin_id claims a decision nobody made.
    expect(FLAT).toContain('CONSTRAINT "skill_candidate_machine_status_chk"');
    const chk =
      FLAT.match(/"skill_candidate_machine_status_chk" CHECK \(([^;]*?)\)\s*(?:,|\))/)?.[1] ?? "";
    expect(chk).toContain("pending");
    expect(chk).toContain("needs_review");
    expect(chk).toContain("reviewer_admin_id");
  });
});

describe("an approval cannot be incomplete", () => {
  it("approved_create must carry a label", () => {
    expect(FLAT).toContain('CONSTRAINT "skill_candidate_create_label_chk"');
    expect(FLAT).toMatch(/skill_candidate_create_label_chk" CHECK[^;]*proposed_skill_name/i);
  });

  it("approved_create must name at least one trade", () => {
    // The SKILL_ORPHAN argument, in the schema. `validateTaxonomyCorpus` refuses a skill with zero
    // `job_domain_skill` edges — "it seeds, it embeds, and it is invisible" — so an approval that
    // names no trade produces a skill nothing can reach. The pipe's `.min(1)` catches it first;
    // this catches it when the pipe is not in the path.
    expect(FLAT).toContain('CONSTRAINT "skill_candidate_create_domain_chk"');
    expect(FLAT).toMatch(/skill_candidate_create_domain_chk" CHECK[^;]*approved_job_domain_ids/i);
  });

  it("counts the trades with cardinality, because array_length does not constrain an empty array", () => {
    // THIS ASSERTION USED TO REQUIRE `array_length`, AND THAT IS THE POINT. `array_length('{}', 1)`
    // is NULL — an empty array has no dimension 1 — so `... >= 1` is NULL, `false OR NULL` is
    // NULL, and a CHECK is SATISFIED by NULL. The constraint accepted exactly the row it exists to
    // refuse, and `'{}'` is the column DEFAULT, so that is the state every row starts in.
    //
    // Measured on the server rather than argued from the manual:
    //   array_length('{}'::text[], 1)  -> NULL      cardinality('{}'::text[])  -> 0
    //   'approved_create' <> 'approved_create' OR array_length('{}'::text[], 1) >= 1  -> NULL
    //   'approved_create' <> 'approved_create' OR cardinality('{}'::text[])   >= 1    -> false
    //
    // Caught before 0093 was applied, so the fix cost one token instead of a migration.
    const chk = FLAT.match(/"skill_candidate_create_domain_chk" CHECK \(([^;]*?)\)\s*,/)?.[1] ?? "";
    expect(chk).not.toBe("");
    expect(chk).toContain("cardinality(");
    expect(chk).not.toContain("array_length");
  });

  it("approved_map / approved_merge must name a resulting skill", () => {
    // A resolution onto nothing is not a decision.
    expect(FLAT).toContain('CONSTRAINT "skill_candidate_resolution_chk"');
    const chk = FLAT.match(/"skill_candidate_resolution_chk" CHECK \(([^;]*?)\)\s*(?:,|\))/)?.[1] ?? "";
    expect(chk).toContain("approved_map");
    expect(chk).toContain("approved_merge");
    expect(chk).toContain("resulting_skill_id");
  });

  it("the closed vocabularies are CHECK-backed, so their unions are honest on the wire", () => {
    // The dto types `status`, `proposed_action`, `confidence_band`, `embedding_status`,
    // `source_type` and match `strength` as UNIONS rather than `string`, and that is only a claim
    // the data can honour because each has a CHECK. `phrase_class`, `classifier_rule`,
    // `trade_family` and `relation` deliberately have none and are typed `string`.
    for (const c of [
      "skill_candidate_status_chk",
      "skill_candidate_action_chk",
      "skill_candidate_band_chk",
      "skill_candidate_match_strength_chk",
      "skill_candidate_source_type_chk",
    ]) {
      expect(FLAT, c).toContain(`CONSTRAINT "${c}"`);
    }
  });
});

describe("duplicate prevention", () => {
  it("one candidate per cluster per run — the writer's upsert target", () => {
    // What makes re-running discovery IDEMPOTENT rather than duplicative: the persist runner's
    // `ON CONFLICT (run_id, cluster_key) DO UPDATE ... WHERE status IN ('pending','needs_review')`
    // needs this exact unique index to conflict against, and without it a second run inserts a
    // second copy of every candidate and the queue doubles.
    expect(FLAT).toMatch(
      /CREATE UNIQUE INDEX "skill_candidate_run_cluster_uq" ON "skill_candidate"[^;]*"run_id","cluster_key"/,
    );
  });

  it("a match is unique per (candidate, skill) — one skill cannot be two pieces of evidence", () => {
    // `MATCH_DUPLICATE_SKILL` is the code-side check; this is the schema-side one.
    expect(FLAT).toMatch(/PRIMARY KEY\("candidate_id","skill_id"\)/);
  });

  it("cluster_key is unique only WITHIN a run, never globally", () => {
    // Deliberate: the same phrase legitimately produces a candidate in run 1 and again in run 5
    // against a changed corpus, and BOTH must stay inspectable. A global unique index would make
    // the second run silently drop what the first already saw — including decisions that were
    // made against a corpus fingerprint that has since moved.
    expect(FLAT).not.toMatch(/CREATE UNIQUE INDEX[^;]*ON "skill_candidate"[^;]*\("cluster_key"\)/);
  });
});

describe("the queue's indexes", () => {
  it("ships the filter index, the keyset index and the prefix index", () => {
    for (const idx of [
      "skill_candidate_queue_idx",
      "skill_candidate_admin_keyset_idx",
      "skill_candidate_norm_prefix_idx",
    ]) {
      expect(FLAT, idx).toContain(`CREATE INDEX "${idx}"`);
    }
  });

  it("the keyset index is DESC NULLS FIRST on BOTH columns", () => {
    // Load-bearing and invisible in a diff — the 0067 lesson, repeated at 0086. Drizzle's bare
    // `desc()` in the repository renders DESC NULLS FIRST; an index built NULLS LAST does not
    // satisfy that ordering, so the planner keeps the index for the filter and adds a Sort anyway,
    // which is the entire cost the index exists to remove.
    expect(FLAT).toMatch(
      /"skill_candidate_admin_keyset_idx" ON "skill_candidate"[^;]*"created_at" DESC NULLS FIRST,"candidate_id" DESC NULLS FIRST/,
    );
  });

  it("the phrase index uses text_pattern_ops, or it cannot serve the anchored LIKE", () => {
    // A btree on the collation-aware default cannot answer `LIKE 'welding%'` outside the C locale,
    // which this cluster is not. Without the operator class the index exists and is never used.
    expect(FLAT).toMatch(/"skill_candidate_norm_prefix_idx"[^;]*"normalized_phrase" text_pattern_ops/);
  });
});

describe("RLS: the staging layer is locked, like every other table in this database", () => {
  it("every one of the four enables, FORCES and REVOKES", () => {
    // ENABLE alone is not enough: the table owner bypasses RLS unless FORCE is set, and REVOKE is
    // what stops the Supabase data-API roles reading it through PostgREST. All three, per table,
    // or the posture has a hole with no error to show for it.
    for (const t of TABLES) {
      expect(FLAT, t).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
      expect(FLAT, t).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
      for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
        expect(FLAT, `${t} / ${role}`).toContain(`REVOKE ALL ON TABLE "${t}" FROM ${role}`);
      }
    }
  });

  it("declares NO policy — deny-by-default, reached only by the owner connection", () => {
    // With FORCE on and zero policies, a Supabase-role client gets an EMPTY RESULT and no error.
    // That zero is not evidence of anything, which is exactly why nothing may query these tables
    // through that path and why `apps/api` reads them on the owner connection.
    expect(FLAT.toUpperCase()).not.toContain("CREATE POLICY");
  });
});

describe("rollback", () => {
  it("the header states the exact rollback, children first", () => {
    // Read from the RAW text on purpose — this one IS a comment, and it is the operator's
    // instruction. Four DROP TABLEs and the database is byte-identical to 0092, which is only
    // true because the migration is additive; the assertions above are what keep that true.
    for (const t of ["skill_candidate_match", "skill_candidate_source", "skill_candidate", "skill_discovery_run"]) {
      expect(RAW).toContain(`DROP TABLE "${t}";`);
    }
    const order = ["skill_candidate_match", "skill_candidate_source", "skill_candidate", "skill_discovery_run"].map(
      (t) => RAW.indexOf(`DROP TABLE "${t}";`),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
