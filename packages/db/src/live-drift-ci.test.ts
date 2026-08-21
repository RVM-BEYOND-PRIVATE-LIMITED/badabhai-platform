/**
 * The CI-safe drift gate — and specifically, its PASSING state.
 *
 * The reason this mode exists rather than `--strict` being wired into `ci.yml` is that nobody
 * had ever observed `--strict` pass. A gate whose green state is theoretical blocks everyone's
 * merges the first time it lands red, and the person who unblocks them deletes the gate.
 *
 * So the first test here is the important one: against the catalog a freshly migrated database
 * MUST have, the verdict is CLEAN. Everything after it mutates that catalog one way at a time
 * and requires the verdict to notice — a gate that cannot fail is not a gate either.
 */
import { describe, expect, it } from "vitest";

import { declaredRoutines, declaredTables } from "./audit-live-drift";
import {
  CI_SAFE_TARGETS,
  bareName,
  ciVerdict,
  expectedFreshCatalog,
  isCiSafeTarget,
  journalEntries,
  render,
  type LiveCatalog,
} from "./live-drift-ci";
import { hostClass } from "./ops-guard";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "..", "migrations");
const JOURNAL = journalEntries(MIGRATIONS);
const DECLARED = declaredTables();
const NO_ROUTINES = { triggers: new Set<string>(), functions: new Set<string>() };
const FRESH = expectedFreshCatalog(JOURNAL);

const judge = (c: LiveCatalog) => ciVerdict(c, DECLARED, NO_ROUTINES, JOURNAL);

describe("the passing state, observed", () => {
  it("is CLEAN against the catalog a freshly migrated database must have", () => {
    // THE TEST THIS WHOLE MODE IS FOR. The fixture is derived from the Drizzle schema, which is
    // sound rather than circular: `drizzle-kit generate` produces the migrations FROM that
    // schema, and the migration-drift CI job already fails when the two disagree.
    const v = judge(FRESH);
    expect(v.problems).toEqual([]);
    expect(v.clean).toBe(true);
    expect(v.unappliedMigrations).toEqual([]);
  });

  it("says so in words a reader can act on", () => {
    expect(render(judge(FRESH), "LOCAL DOCKER").join("\n")).toContain("CLEAN");
  });

  it("is deterministic — the same catalog is the same verdict", () => {
    // No clock, no environment, no ordering dependence. A gate that flickers is a gate people
    // re-run until it passes.
    expect(judge(FRESH)).toEqual(judge(FRESH));
    expect(judge({ ...FRESH, tables: [...FRESH.tables].reverse() })).toEqual(judge(FRESH));
  });

  it("judges a real number of tables, so the fixture is not vacuously empty", () => {
    expect(FRESH.tables.length).toBeGreaterThan(50);
    expect(FRESH.recordedMigrationHashes.length).toBe(JOURNAL.length);
  });
});

describe("every direction of drift turns it red", () => {
  it("an UNDECLARED table", () => {
    // The GAP-DB-21 direction. On a database built only from these migrations, an extra table
    // means one was created out of band.
    const v = judge({ ...FRESH, tables: [...FRESH.tables, { table: "_something_by_hand", columns: ["id"] }] });
    expect(v.clean).toBe(false);
    expect(v.problems.join(" ")).toContain("_something_by_hand");
    expect(v.problems.join(" ")).toContain("created out of band");
  });

  it("a MISSING table", () => {
    const v = judge({ ...FRESH, tables: FRESH.tables.slice(1) });
    expect(v.clean).toBe(false);
    expect(v.problems.join(" ")).toContain("MISSING tables");
    expect(v.problems.join(" ")).toContain(FRESH.tables[0]!.table);
  });

  it("an UNDECLARED column", () => {
    const [first, ...rest] = FRESH.tables;
    const v = judge({ ...FRESH, tables: [{ ...first!, columns: [...first!.columns, "added_by_hand"] }, ...rest] });
    expect(v.clean).toBe(false);
    expect(v.problems.join(" ")).toContain("added_by_hand");
  });

  it("a MISSING column", () => {
    const [first, ...rest] = FRESH.tables;
    const v = judge({ ...FRESH, tables: [{ ...first!, columns: first!.columns.slice(1) }, ...rest] });
    expect(v.clean).toBe(false);
    expect(v.problems.join(" ")).toContain("MISSING columns");
  });

  it("an UNDECLARED trigger — the one that fires during someone else's migration", () => {
    const v = judge({ ...FRESH, triggers: ["workers._t_log_del_workers"] });
    expect(v.clean).toBe(false);
    expect(v.undeclaredTriggers).toEqual(["workers._t_log_del_workers"]);
    expect(v.problems.join(" ")).toContain("appears in no migration");
  });

  it("an UNDECLARED function", () => {
    const v = judge({ ...FRESH, functions: ["_log_delete"] });
    expect(v.clean).toBe(false);
    expect(v.undeclaredFunctions).toEqual(["_log_delete"]);
  });

  it("an UNDECLARED event trigger — #1110's `ensure_rls` is exactly this shape", () => {
    const v = judge({ ...FRESH, eventTriggers: ["ensure_rls"] });
    expect(v.clean).toBe(false);
    expect(v.undeclaredEventTriggers).toEqual(["ensure_rls"]);
  });

  it("accepts a routine a migration DOES declare", () => {
    // The other half: the gate must go green again once the routine is written down, or the only
    // way to satisfy it would be to delete the routine.
    const declared = { triggers: new Set(["_t_log_del_workers", "ensure_rls"]), functions: new Set(["_log_delete"]) };
    const v = ciVerdict(
      { ...FRESH, triggers: ["workers._t_log_del_workers"], functions: ["_log_delete"], eventTriggers: ["ensure_rls"] },
      DECLARED,
      declared,
      JOURNAL,
    );
    expect(v.clean).toBe(true);
  });
});

describe("an unmigrated database is diagnosed, not mis-reported", () => {
  const halfMigrated: LiveCatalog = {
    ...FRESH,
    tables: [],
    recordedMigrationHashes: FRESH.recordedMigrationHashes.slice(0, 3),
  };

  it("names the missing migrations", () => {
    const v = judge(halfMigrated);
    expect(v.clean).toBe(false);
    expect(v.unappliedMigrations.length).toBe(JOURNAL.length - 3);
    expect(v.problems.join(" ")).toContain("run db:migrate first");
  });

  it("does NOT report every table as missing — that is true and it is the wrong diagnosis", () => {
    // The failure mode this short-circuit exists for: 60-odd confident "MISSING table" lines
    // that send the reader hunting an out-of-band DROP that never happened.
    const v = judge(halfMigrated);
    expect(v.drift.missingTables).toEqual([]);
    expect(v.drift.missingColumns).toEqual([]);
    expect(v.problems).toHaveLength(1);
  });

  it("says so in the report, and stops", () => {
    const out = render(judge(halfMigrated), "LOCAL DOCKER").join("\n");
    expect(out).toContain("NOT APPLIED");
    expect(out).toContain("Drift is NOT judged");
    expect(out).not.toContain("CLEAN");
  });
});

describe("the target guard", () => {
  it("judges only a local database", () => {
    // The question this mode asks — "is the live schema EXACTLY what the schema declares" — is
    // not meaningful against production, which legitimately carries objects this repository does
    // not model. Running it there would produce the red job people learn to disable.
    expect(isCiSafeTarget("LOCAL DOCKER")).toBe(true);
    expect(isCiSafeTarget("SUPABASE (remote)")).toBe(false);
    expect(isCiSafeTarget("OTHER-REMOTE")).toBe(false);
    expect(isCiSafeTarget("UNPARSEABLE")).toBe(false);
  });

  it("keeps the allow-list to exactly one class", () => {
    expect([...CI_SAFE_TARGETS]).toEqual(["LOCAL DOCKER"]);
  });
});

describe("the journal read", () => {
  it("hashes every migration file, one entry per journal row", () => {
    expect(JOURNAL.length).toBeGreaterThan(80);
    for (const e of JOURNAL) {
      expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(e.tag).toMatch(/^\d{4}_/);
    }
  });

  it("gives every migration a DISTINCT hash", () => {
    // Two identical files would make one of them invisible to the applied-check.
    expect(new Set(JOURNAL.map((e) => e.hash)).size).toBe(JOURNAL.length);
  });
});

describe("bareName", () => {
  it("strips the table qualifier a trigger carries and leaves a plain name alone", () => {
    // Triggers are recorded as `table.trigger` so the report can say where they fire, but a
    // migration declares only the trigger's own name.
    expect(bareName("workers._t_log_del_workers")).toBe("_t_log_del_workers");
    expect(bareName("ensure_rls")).toBe("ensure_rls");
  });
});

/**
 * Design question 3, converted from an assumption into a test.
 *
 * The proposal listed four things to argue about before this lands, and flagged one of them as
 * *"the one assumption that has not been executed"*: does CI's own `DATABASE_URL` classify as
 * `LOCAL DOCKER`? If it does not, the step exits 2 — the safe direction, mis-configured rather
 * than silently passing, but a permanently red job nobody can fix from the gate's side.
 *
 * It is answerable without running anything: the URL is a literal in the workflow. Reading it
 * from the file rather than restating it here is the point — a copy would keep agreeing with
 * itself after someone changed the workflow.
 */
describe("design Q3 — CI's own DATABASE_URL classifies as a target this mode accepts", () => {
  const ciYml = readFileSync(join(__dirname, "..", "..", "..", ".github", "workflows", "ci.yml"), "utf8");

  it("the e2e job's DATABASE_URL is present and points at localhost", () => {
    const urls = [...ciYml.matchAll(/DATABASE_URL:\s*(postgres(?:ql)?:\/\/\S+)/g)].map((m) => m[1]!);
    expect(urls.length, "no literal DATABASE_URL found in ci.yml — has the job changed?").toBeGreaterThan(0);
    for (const u of urls) {
      expect(hostClass(u)).toBe("LOCAL DOCKER");
      expect(isCiSafeTarget(hostClass(u))).toBe(true);
    }
  });

  it("...and a Supabase URL in the same position would be REFUSED, not silently judged", () => {
    // The other half of the same question. The guard must be what stops a mis-pointed job,
    // not the absence of one.
    const prod = "postgresql://postgres.abc:pw@aws-1-ap-south-1.pooler.supabase.com:5432/postgres";
    expect(isCiSafeTarget(hostClass(prod))).toBe(false);
  });
});

/**
 * Design question 4, and the conflict it assumed turns out not to exist.
 *
 * *"Undeclared routines are currently a failure... it means #1110's eventual resolution has to
 * include declaring whatever stays."* That reads as a coupling, and it is worth checking rather
 * than accepting, because the gate only ever sees a FRESH database.
 *
 * A fresh database has none of #1110's routines — they are undeclared, so no migration creates
 * them there. Whatever #1110 decides, the CI gate's fresh-database view is unaffected: declare
 * them and the gate expects what the migration builds; drop them and there was nothing there
 * anyway. The gate cannot see the production-only state at all, which is exactly why it refuses
 * production.
 */
describe("design Q4 — the fresh-database view is independent of #1110's outcome", () => {
  it("a freshly migrated database has no undeclared routine, so the rule is free today", () => {
    const fresh = expectedFreshCatalog(JOURNAL);
    const v = ciVerdict(fresh, DECLARED, declaredRoutines(join(__dirname, "..", "migrations")), JOURNAL);
    expect(v.undeclaredTriggers).toEqual([]);
    expect(v.undeclaredFunctions).toEqual([]);
    expect(v.undeclaredEventTriggers).toEqual([]);
  });

  it("...and stays free if #1110 DECLARES them, because then they are declared", () => {
    // The case the question worried about: `ensure_rls` and friends land in a migration. The
    // fresh database then HAS them and the repo DECLARES them, so the gate stays green — the
    // two move together by construction.
    const fresh = expectedFreshCatalog(JOURNAL);
    const withRoutines = {
      ...fresh,
      functions: ["rls_auto_enable"],
      eventTriggers: ["ensure_rls"],
    };
    const declaredToo = { triggers: new Set<string>(), functions: new Set(["rls_auto_enable"]) };
    const v = ciVerdict(withRoutines, DECLARED, declaredToo, JOURNAL);
    expect(v.undeclaredFunctions).toEqual([]);
    // An event trigger is not a function and has no CREATE FUNCTION to match, so it is still
    // reported — which is correct and is the one thing declaring them would have to handle.
    expect(v.undeclaredEventTriggers).toEqual(["ensure_rls"]);
  });
});
