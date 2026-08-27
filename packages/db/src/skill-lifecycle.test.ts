/**
 * The skill / skill-alias lifecycle — and the assertions that keep it honest.
 *
 * Two groups matter more than the rest:
 *
 *   - **"nothing produces vocabulary unattended"**, which is the claim the whole model exists
 *     to make. If it ever fails, an ingestion route has become fully automatic and CLAUDE.md §3
 *     needs re-reading against it — mapping a phrase to a canonical id is a business decision.
 *   - **the writer scan**, which is checked against fabricated inputs as well as the real tree,
 *     because a scan that cannot fail proves nothing about the tree it passes on.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  SPINE_TABLES,
  SPINE_WRITER_ROOTS,
  crossVocabularyWriters,
  scanWriters,
  scanWritersAcross,
  sourceFiles,
  spineSourceFiles,
  stripComments,
  tablesWrittenIn,
  workspacesDependingOnDb,
} from "./lifecycle-writer-scan";
import {
  LIFECYCLE,
  automaticPrefix,
  fullyAutomaticPaths,
  humanGates,
  reachesProductAutomatically,
  trafficDrivenPaths,
  validateLifecycle,
  type LifecyclePath,
  type LifecycleStep,
} from "./skill-lifecycle";

const SRC = __dirname;
/** `packages/db/src` -> `packages/db` -> `packages` -> the repo. */
const REPO_ROOT = join(SRC, "..", "..", "..");

const step = (o: Partial<LifecycleStep> & { id: string }): LifecycleStep => ({
  what: "w",
  actor: "OFFLINE_RUNNER",
  performedBy: "pnpm x",
  writes: "repository_file",
  ...o,
});

const path = (o: Partial<LifecyclePath> & { id: string }): LifecyclePath => ({
  title: "t",
  origin: "HAND_AUTHORED",
  produces: "repository_file",
  steps: [step({ id: `${o.id}.1` })],
  everCompleted: "n/a",
  ...o,
});

// ---------------------------------------------------------------------------
describe("validateLifecycle", () => {
  const writers = new Set(["seed-skills.ts"]);

  it("accepts a coherent path", () => {
    expect(validateLifecycle([path({ id: "A" })], writers)).toEqual([]);
  });

  it("refuses a path that claims to produce something no step writes", () => {
    // Otherwise `produces` is an aspiration and a reader cannot tell the difference.
    const p = validateLifecycle([path({ id: "A", produces: "skill_alias" })], writers);
    expect(p[0]?.problem).toMatch(/claims to produce skill_alias/);
  });

  it("refuses a runner that writes a table without naming its writer file", () => {
    const p = validateLifecycle(
      [path({ id: "A", produces: "skill_alias", steps: [step({ id: "A.1", writes: "skill_alias" })] })],
      writers,
    );
    expect(p[0]?.problem).toMatch(/names no writer file/);
  });

  it("refuses a writer file the source scan did not find", () => {
    const p = validateLifecycle(
      [
        path({
          id: "A",
          produces: "skill_alias",
          steps: [step({ id: "A.1", writes: "skill_alias", writerFile: "ghost.ts" })],
        }),
      ],
      writers,
    );
    expect(p[0]?.problem).toMatch(/names writer ghost\.ts/);
  });

  it("refuses a HUMAN or MODEL step that claims to write a table directly", () => {
    // A person writes files; a model writes proposals. Marking a table write as HUMAN would
    // hide an unguarded runner behind a person who is not actually typing SQL.
    for (const actor of ["HUMAN", "MODEL"] as const) {
      const p = validateLifecycle(
        [
          path({
            id: actor,
            produces: "skill",
            steps: [step({ id: `${actor}.1`, actor, writes: "skill" })],
          }),
        ],
        writers,
      );
      expect(p[0]?.problem, actor).toMatch(new RegExp(`actor ${actor} cannot write skill`));
    }
  });

  it("refuses duplicate ids and empty paths", () => {
    expect(validateLifecycle([path({ id: "A" }), path({ id: "A" })], writers)[0]?.problem).toMatch(
      /duplicate path id/,
    );
    expect(validateLifecycle([path({ id: "B", steps: [] })], writers)[0]?.problem).toMatch(
      /no steps/,
    );
  });
});

// ---------------------------------------------------------------------------
describe("automaticPrefix", () => {
  it("stops at the first human, not the last", () => {
    const p = path({
      id: "A",
      steps: [
        step({ id: "1", actor: "RUNTIME" }),
        step({ id: "2", actor: "HUMAN" }),
        step({ id: "3", actor: "OFFLINE_RUNNER" }),
      ],
    });
    expect(automaticPrefix(p).map((s) => s.id)).toEqual(["1"]);
    expect(humanGates(p).map((s) => s.id)).toEqual(["2"]);
  });

  it("is the whole path when no person is involved", () => {
    const p = path({ id: "A", steps: [step({ id: "1", actor: "RUNTIME" })] });
    expect(automaticPrefix(p)).toHaveLength(1);
  });

  it("separates 'writes a table unattended' from 'produces its output unattended'", () => {
    // The distinction the growth loops turn on: the QUEUE fills by itself, the VOCABULARY
    // does not. Collapsing them reads as "the learning loop is automatic".
    const p = path({
      id: "GROWTH",
      produces: "skill_alias",
      steps: [
        step({ id: "1", actor: "RUNTIME", writes: "unresolved_phrase" }),
        step({ id: "2", actor: "HUMAN" }),
        step({ id: "3", writes: "skill_alias", writerFile: "seed-skills.ts" }),
      ],
    });
    expect(automaticPrefix(p)).toHaveLength(1);
    expect(reachesProductAutomatically(p)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("the real lifecycle", () => {
  const scan = scanWriters(SRC);

  it("is coherent against the real source tree", () => {
    expect(validateLifecycle(LIFECYCLE, scan.writers)).toEqual([]);
  });

  it("declares five paths, three of which start from a worker utterance", () => {
    expect(LIFECYCLE).toHaveLength(5);
    expect(trafficDrivenPaths().map((p) => p.id)).toEqual([
      "P3-SKILL-GROWTH",
      "P4-OCCUPATION-GROWTH",
      "P5-MINING",
    ]);
  });

  it("NOT ONE PATH produces its vocabulary without a person", () => {
    // The headline. Coverage is a function of review cadence, not of traffic.
    for (const p of LIFECYCLE) {
      expect(reachesProductAutomatically(p), p.id).toBe(false);
      expect(humanGates(p).length, p.id).toBeGreaterThan(0);
    }
    expect(fullyAutomaticPaths()).toEqual([]);
  });

  it("and every traffic-driven path stalls at a mapping decision, not at a runner", () => {
    // The human gate is always "which canonical id does this phrase mean" — the one thing
    // §3 reserves for a person. Worth pinning: a future 'optimization' that removes it would
    // be removing the business decision, not a bottleneck.
    for (const p of trafficDrivenPaths()) {
      const firstGate = humanGates(p)[0]!;
      expect(firstGate.writes, p.id).toBe("repository_file");
    }
  });

  it("names only runners that exist", () => {
    const files = new Set(sourceFiles(SRC));
    for (const p of LIFECYCLE) {
      for (const s of p.steps) {
        if (s.writerFile !== undefined) expect(files.has(s.writerFile), s.id).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe("the writer scan", () => {
  const scan = scanWriters(SRC);

  it("finds exactly one writer for job_domain_skill — the Path A scope bottleneck", () => {
    // 28 of 3,885 selectable occupations carry an edge, and this is why: one seeder, fed by
    // one hand-picked file. Any second writer is a new ingestion route and should be read.
    expect([...(scan.byTable.get("job_domain_skill") ?? [])]).toEqual(["seed-domain-skills.ts"]);
  });

  it("finds no path from the occupation vocabulary into the skill vocabulary", () => {
    // Directionality. `job_domain_alias` holds job titles; deriving `skill_alias` from it
    // would put job titles into the skill id space.
    expect(crossVocabularyWriters(SRC)).toEqual([]);
  });

  it("attributes every skill_alias writer to a declared lifecycle role", () => {
    // Not a fixed list — a fixed list is the writers someone remembered. Instead: every
    // discovered writer must be one the model names, or a maintenance runner the model
    // deliberately excludes (normalization, election, embedding, retag, rollback, provenance).
    const declared = new Set(
      LIFECYCLE.flatMap((p) => p.steps.map((s) => s.writerFile)).filter(
        (f): f is string => f !== undefined,
      ),
    );
    const maintenance = new Set([
      "decollide-skill-aliases.ts", // election — de-elects a duplicate, adds no vocabulary
      "normalize-skill-aliases.ts", // fills text_norm, never text
      "retag-skills.ts", // moves an alias between skills, adds no vocabulary
      "s3d-rollback.ts", // restores rows the database already had
      "verify-embedding-provenance.ts", // stamps embedding_model on proven rows
    ]);
    for (const f of scan.byTable.get("skill_alias") ?? []) {
      expect(declared.has(f) || maintenance.has(f), `${f} writes skill_alias but no role claims it`).toBe(
        true,
      );
    }
  });

  it("does NOT count a statement quoted in a comment", () => {
    const code = stripComments(`/* UPDATE skill_alias SET embedding = NULL */\nconst x = 1;`);
    expect(code).not.toContain("UPDATE skill_alias");
  });

  it("does NOT count a statement rendered into a plain string", () => {
    // `deprecation-seed-plan.ts` RENDERS the SQL a separate runner executes, and
    // `audit-alias-collision-cleanup.ts` PRINTS the de-election it refuses to run. Counting
    // them would flag the files most careful to separate planning from execution.
    for (const f of ["deprecation-seed-plan.ts", "audit-alias-collision-cleanup.ts"]) {
      const src = readFileSync(join(SRC, f), "utf8");
      expect(src).toMatch(/UPDATE skill/); // it really does contain the text …
      expect(scan.writers.has(f), f).toBe(false); // … and is still not a writer
    }
  });

  it("does count a statement inside a dsql tagged template", () => {
    // The inverse of the case above, on the runner that actually performs the de-election.
    expect(scan.writers.has("decollide-skill-aliases.ts")).toBe(true);
    expect(scan.writers.has("seed-deprecations.ts")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("db:mine:aliases can reach its credentials", () => {
  it("loads the repository-root .env like the other db runners", () => {
    // It did not, for its entire life. `pnpm db:mine:aliases` runs with cwd = packages/db,
    // where a bare `config()` finds no file, so the runner threw `DATABASE_URL is not set`
    // before touching anything. The fault was invisible because the generator had no traffic
    // to mine — the failure read as "not wired up yet". `chat_messages` now holds inbound
    // rows, so it is reachable, and this pins the fix.
    const src = readFileSync(join(SRC, "mine-chat-aliases.ts"), "utf8");
    expect(src).toContain('config({ path: "../../.env" })');
  });
});

// ---------------------------------------------------------------------------
// THE SCAN OVER THE WHOLE REPOSITORY, not just this package
// ---------------------------------------------------------------------------
//
// Every claim above is measured over `packages/db/src`. The claims themselves are repo-wide —
// this module's header says the property that matters is "these files, and no others, can create
// a `skill_alias` row" — so measuring them over one directory made them true of a fraction of the
// codebase and asserted of all of it.
//
// The gap was not hypothetical in shape, only in luck: `apps/api` imports `@badabhai/db` in 198
// files and holds every HTTP request path in the product. A `.insert(skills)` added there while
// implementing "approve and create it" on the skill-review surface would have passed every
// assertion in this file, because this file could not see the directory it was in.

describe("the writer scan, over EVERY workspace that can reach the database", () => {
  const repoScan = scanWritersAcross(REPO_ROOT);

  it("reads both roots, and reads them RECURSIVELY", () => {
    // The failure this guards is an audit that returns "nothing found" because it looked at
    // nothing. `packages/db/src` is flat; `apps/api/src` is ~40 nested modules, so a
    // non-recursive walk over the second returns a handful of files and a clean report.
    const counts = SPINE_WRITER_ROOTS.map((r) => spineSourceFiles(REPO_ROOT, r).length);
    for (const n of counts) expect(n).toBeGreaterThan(100);
    expect(repoScan.writers.size).toBeGreaterThan(0);
  });

  it("the root list is EXHAUSTIVE — no third workspace depends on @badabhai/db", () => {
    // The roots are chosen by a mechanism, not by memory: a writer needs the Drizzle models or a
    // connection, and both arrive through this package. So the honest way to keep the list
    // complete is to re-derive the dependent set from the workspace manifests every run. A new
    // consumer then becomes a DECISION about SPINE_WRITER_ROOTS rather than a silent hole in it.
    const dependents = workspacesDependingOnDb(REPO_ROOT);
    expect(dependents).toEqual(["apps/api"]);
    const covered = new Set(SPINE_WRITER_ROOTS.map((r) => r.dir.split("/").slice(0, 2).join("/")));
    for (const d of dependents) expect(covered.has(d), `${d} depends on db but is not scanned`).toBe(true);
    expect(covered.has("packages/db")).toBe(true);
  });

  it("NO request path can write any of the five corpus tables", () => {
    // THE HEADLINE, and the reason the whole skill-review layer is safe to ship: an approval
    // RECORDS a decision on `skill_candidate` and stops. Minting the corpus stays in the offline
    // chain, which has its own human in it and gates a request path does not have.
    //
    // Named, not counted: a failure has to say WHICH file, so the reader can judge whether it is
    // a mistake or a decision. If it is a decision it needs a second human either way.
    for (const table of ["skill", "skill_alias", "job_domain", "job_domain_alias", "job_domain_skill"] as const) {
      const inApi = [...(repoScan.byTable.get(table) ?? [])].filter((f) => f.startsWith("apps/"));
      expect(inApi, `${table} is written from a request path`).toEqual([]);
    }
  });

  it("the ONE spine write outside packages/db is unresolved_phrase, and it is a discovery INPUT", () => {
    // An equality, so this fails in BOTH directions: a new app-side writer appears, or this one
    // disappears. `unresolved_phrase` records that a worker used a phrase the taxonomy does not
    // have — it mints no skill, no alias and no edge, it is an idempotent upsert with a counter,
    // and it is one of the sources the discovery pipeline reads. Refusing it would mean the
    // platform could not record what it does not know, which is the thing this workstream exists
    // to fix.
    const outsideDb = [...repoScan.byFile.entries()]
      .filter(([file]) => !file.startsWith("packages/db/"))
      .map(([file, tables]) => [file, [...tables].sort()] as const)
      .sort();
    expect(Object.fromEntries(outsideDb)).toEqual({
      "apps/api/src/skills/skills.repository.ts": ["unresolved_phrase"],
    });
  });

  it("still finds exactly one writer for job_domain_skill, now across the whole repo", () => {
    // The same assertion the packages/db-only scan makes two describes up — restated where it
    // actually means what it says. 28 of 3,885 selectable occupations carry an edge because ONE
    // seeder, fed by one hand-picked file, is the only thing that can create one.
    expect([...(repoScan.byTable.get("job_domain_skill") ?? [])]).toEqual([
      "packages/db/src/seed-domain-skills.ts",
    ]);
  });

  it("is CAPABLE of seeing an app-side write — the tag name is not a blind spot", () => {
    // The first run of this scan reported ZERO writers in `apps/api` and was wrong. `packages/db`
    // imports drizzle's `sql` AS `dsql` throughout and the matcher was written for that; `apps/api`
    // imports it as `sql`, so the scan read 437 files and found no raw SQL in any of them — a
    // clean bill of health for the workspace it had just been extended to cover.
    //
    // This is the regression test for that, pinned to the real statement in the real file rather
    // than to a synthetic one, because the synthetic version is what passed while the real one
    // was invisible.
    expect(repoScan.byTable.get("unresolved_phrase")).toContain(
      "apps/api/src/skills/skills.repository.ts",
    );
  });

  it("the raw-SQL detector reads every write verb, and reads the TABLE not a prefix", () => {
    // ONE LITERAL regex that captures the table each write statement names, rather than a pattern
    // built per table. The constructed form — `new RegExp(`INSERT INTO "?${table}"?…`)` — is a
    // ReDoS shape `semgrep detect-non-literal-regexp` blocks, and this repository has now been
    // bitten by it three times; `audit-undeclared-routines.ts` documents the previous two.
    //
    // The inversion is also SHARPER than what it replaced. Equality beats the `(?![a-z_])`
    // boundary the per-table patterns needed, and the 0093 staging tables are named after the
    // corpus tables they stage for — so a scan that treats `skill` as a prefix flags the review
    // layer's own guarded write as a corpus write, and the audit has to be switched off to ship.
    expect([...tablesWrittenIn("INSERT INTO skill (a) VALUES (1)")]).toEqual(["skill"]);
    expect([...tablesWrittenIn('UPDATE "skill_alias" SET x = 1')]).toEqual(["skill_alias"]);
    expect([...tablesWrittenIn("DELETE FROM job_domain_skill WHERE x")]).toEqual([
      "job_domain_skill",
    ]);
    expect([...tablesWrittenIn("TRUNCATE TABLE skill")]).toEqual(["skill"]);
    expect([...tablesWrittenIn("truncate skill")]).toEqual(["skill"]);
  });

  it("the detector reports the staging table AS ITSELF, never as the corpus table", () => {
    // The assertion that makes the equality worth having. Under a prefix rule every one of these
    // would read as a write to `skill` or `job_domain`.
    for (const [sql, table] of [
      ["INSERT INTO skill_candidate (a) VALUES (1)", "skill_candidate"],
      ["INSERT INTO skill_candidate_source (a) VALUES (1)", "skill_candidate_source"],
      ["UPDATE skill_candidate_match SET x = 1", "skill_candidate_match"],
      ["UPDATE skill_discovery_run SET x = 1", "skill_discovery_run"],
    ] as const) {
      expect([...tablesWrittenIn(sql)], sql).toEqual([table]);
    }
    // And none of them is a spine table, which is what keeps them out of the scan entirely.
    for (const t of ["skill_candidate", "skill_candidate_source", "skill_candidate_match"]) {
      expect(Object.keys(SPINE_TABLES)).not.toContain(t);
    }
  });

  it("the detector finds SEVERAL writes in one block, and is not left stateful by the g flag", () => {
    // `WRITE_STATEMENT` carries `g`, so it has a `lastIndex`. `matchAll` resets it; a `.test()`
    // loop would not, and every second call would start mid-string and miss the first statement.
    // Calling twice with the same input is the cheapest way to catch that.
    const sql = "INSERT INTO skill (a) VALUES (1); UPDATE skill_alias SET x = 1; DELETE FROM job_domain WHERE y";
    const first = [...tablesWrittenIn(sql)].sort();
    const second = [...tablesWrittenIn(sql)].sort();
    expect(first).toEqual(["job_domain", "skill", "skill_alias"]);
    expect(second).toEqual(first);
  });

  it("does not confuse the 0093 staging tables for the corpus tables they are named after", () => {
    // `skill_candidate` is not `skill`; `skill_candidate_source` is not `skill`. A scan that could
    // not tell them apart would flag the review layer's own guarded write as a corpus write, and
    // the audit would have to be switched off to ship anything.
    const stagingWriters = ["packages/db/src/persist-discovery-run.ts", "packages/db/src/backfill-resulting-skill.ts"];
    for (const f of stagingWriters) {
      expect(repoScan.byFile.get(f), `${f} must write no corpus table`).toBeUndefined();
    }
  });
});
