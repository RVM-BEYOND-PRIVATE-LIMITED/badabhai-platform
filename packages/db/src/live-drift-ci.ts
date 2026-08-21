/**
 * `db:audit:live-drift:ci` — the DETERMINISTIC half of the drift audit, designed to be a gate.
 *
 *   pnpm db:audit:live-drift:ci                      # judge the database in DATABASE_URL
 *   pnpm db:audit:live-drift:ci --catalog-out=<p>    # ...and record the catalog it judged
 *   pnpm db:audit:live-drift:ci --from-json=<p>      # judge a RECORDED catalog, no database
 *
 * ===========================================================================
 * WHY THIS IS A SEPARATE ENTRY POINT AND NOT `--strict`
 * ===========================================================================
 * `db:audit:live-drift` is an INVESTIGATIVE tool. Against production it reports six undeclared
 * routines, an undeclared table and a set of questions — all of them real, none of them a
 * verdict. It already has a `--strict` flag, and wiring THAT into CI would have been the obvious
 * move and the wrong one, for three reasons that are only visible once you try:
 *
 *   1. NOBODY HAD RUN IT AGAINST A FRESH DATABASE. A gate whose passing state has never been
 *      observed is not a gate, it is a coin flip that blocks everyone's merges when it lands
 *      tails. That is why this exists as a reviewable PR instead of an edit to `ci.yml`.
 *   2. IT WOULD FAIL FOREVER AGAINST PRODUCTION. `--strict` has no opinion about its target, so
 *      the same command means "the repo and the database agree" in CI and "here are eight open
 *      questions" against production. A red job an operator learns to ignore is worse than none.
 *   3. A HALF-MIGRATED DATABASE REPORTS AS DRIFT. `missingTables` on a database that simply has
 *      not run `db:migrate` yet is a true statement and a useless diagnosis — the reader goes
 *      looking for an out-of-band ALTER that never happened.
 *
 * This mode answers a narrower question, and answers it the same way every time:
 *
 *   > Against a database built ONLY from this repository's migrations, is the live schema
 *   > exactly what the Drizzle schema declares — no extra table, no missing column, no
 *   > undeclared routine?
 *
 * ===========================================================================
 * THE THREE THINGS THAT MAKE IT DETERMINISTIC
 * ===========================================================================
 *   TARGET GUARD      it refuses a remote/production-class target outright. The question above
 *                     is not meaningful there, and letting it run would produce exactly the red
 *                     job people learn to disable.
 *   MIGRATION STATE   it proves the database is fully migrated BEFORE judging drift, so
 *                     "you did not migrate" can never be reported as "the schema drifted".
 *   PURE VERDICT      {@link ciVerdict} takes a catalog and returns a verdict. No clock, no
 *                     environment, no ordering dependence — the same input is the same answer.
 *
 * ===========================================================================
 * AND THE ONE THAT MAKES IT REVIEWABLE WITHOUT DOCKER
 * ===========================================================================
 * `--from-json` judges a RECORDED catalog. That is what closes the loop honestly: the verdict
 * function is exercised in the tests against the catalog a fresh database MUST have — which is
 * `declaredTables()` itself, since the migrations are generated from that schema — and against
 * mutations of it, so both answers are observed.
 *
 * What that does NOT prove, stated plainly rather than left for a reader to notice: the SQL that
 * turns a real database into a catalog is still only exercised by running it. `--catalog-out`
 * exists so the first person with a live database can record one and commit it as a fixture.
 *
 * ===========================================================================
 * EXIT CODES — the contract a CI step would depend on
 * ===========================================================================
 *   0  clean: the live schema is exactly what the schema declares
 *   1  drift, or migrations not applied. The report names every difference
 *   2  REFUSED: the target is not one this mode can judge. Distinct from 1 on purpose — a CI
 *      step that got 2 is mis-CONFIGURED, and reading that as "the schema drifted" would send
 *      the reader to the wrong file entirely
 *
 * Verified by hand against all three paths; see `docs/registers/live-drift-ci-gate-design.md`.
 */
import { config } from "dotenv";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sql as dsql } from "drizzle-orm";

import { createDbClient } from "./client";
import { hostClass, type TargetClass } from "./ops-guard";
import {
  declaredRoutines,
  declaredTables,
  drift,
  isClean,
  type DeclaredRoutines,
  type Drift,
  type LiveTable,
} from "./audit-live-drift";

config({ path: join("..", "..", ".env") });

const SCRIPT = "audit:live-drift:ci";

/**
 * A recorded snapshot of everything this mode judges.
 *
 * Deliberately a plain, sorted, serialisable object: it is the unit `--from-json` reads, the
 * unit `--catalog-out` writes, and the unit the tests build fixtures from. Sorted at
 * construction so two recordings of the same database compare byte for byte.
 */
export interface LiveCatalog {
  readonly tables: readonly LiveTable[];
  readonly triggers: readonly string[];
  readonly functions: readonly string[];
  readonly eventTriggers: readonly string[];
  /** Journal tags recorded in `drizzle.__drizzle_migrations`, by hash. */
  readonly recordedMigrationHashes: readonly string[];
}

export interface CiVerdict {
  readonly clean: boolean;
  readonly drift: Drift;
  readonly undeclaredTriggers: readonly string[];
  readonly undeclaredFunctions: readonly string[];
  readonly undeclaredEventTriggers: readonly string[];
  /** Journal tags this database has NOT recorded. Non-empty means "migrate first". */
  readonly unappliedMigrations: readonly string[];
  readonly problems: readonly string[];
}

/** Target classes this mode will judge. Anything else is refused before a query runs. */
export const CI_SAFE_TARGETS: readonly TargetClass[] = ["LOCAL DOCKER"];

export function isCiSafeTarget(t: TargetClass): boolean {
  return CI_SAFE_TARGETS.includes(t);
}

/**
 * The verdict. Pure.
 *
 * MIGRATION STATE IS CHECKED FIRST AND SHORT-CIRCUITS. An unmigrated database produces a long,
 * confident list of "missing" tables, every one of which is a true statement and a wrong
 * diagnosis. Reporting the real cause and stopping is the difference between a gate someone can
 * act on and a wall of noise.
 */
export function ciVerdict(
  catalog: LiveCatalog,
  declared: readonly { table: string; columns: readonly string[] }[],
  declaredRoutineNames: DeclaredRoutines,
  journalTags: readonly { tag: string; hash: string }[],
): CiVerdict {
  const recorded = new Set(catalog.recordedMigrationHashes);
  const unapplied = journalTags.filter((e) => !recorded.has(e.hash)).map((e) => e.tag);

  const empty: Drift = { undeclaredTables: [], missingTables: [], undeclaredColumns: [], missingColumns: [] };
  if (unapplied.length > 0) {
    return {
      clean: false,
      drift: empty,
      undeclaredTriggers: [],
      undeclaredFunctions: [],
      undeclaredEventTriggers: [],
      unappliedMigrations: unapplied,
      problems: [
        `${unapplied.length} migration(s) are not applied to this database — run db:migrate first. ` +
          `Judging drift now would report every table they create as MISSING, which is true and useless.`,
      ],
    };
  }

  const d = drift(catalog.tables, declared);
  const undeclaredTriggers = catalog.triggers.filter((t) => !declaredRoutineNames.triggers.has(bareName(t)));
  const undeclaredFunctions = catalog.functions.filter((f) => !declaredRoutineNames.functions.has(f));
  // Against `eventTriggers`, not `triggers` — an event trigger is a different catalog and a
  // different declaration. Before #1110 declared `ensure_rls` this read the table-trigger set,
  // which no `CREATE EVENT TRIGGER` can ever populate, so the name was unconditionally reported
  // as undeclared however the migrations were written.
  const undeclaredEventTriggers = catalog.eventTriggers.filter(
    (e) => !declaredRoutineNames.eventTriggers.has(bareName(e)),
  );

  const problems: string[] = [];
  const say = (what: string, items: readonly string[], why: string): void => {
    if (items.length > 0) problems.push(`${what} (${items.length}): ${items.join(", ")} — ${why}`);
  };
  say("MISSING tables", d.missingTables, "code is compiled against a table that does not exist");
  say("MISSING columns", d.missingColumns, "declared on a modelled table and absent live");
  say(
    "UNDECLARED tables",
    d.undeclaredTables,
    "this database was built only from this repo's migrations, so an extra table means one was created out of band",
  );
  say("UNDECLARED columns", d.undeclaredColumns, "an out-of-band ALTER");
  say("UNDECLARED triggers", undeclaredTriggers, "fires during any write and appears in no migration");
  say("UNDECLARED functions", undeclaredFunctions, "no migration creates these");
  say("UNDECLARED event triggers", undeclaredEventTriggers, "fire on DDL itself");

  return {
    clean: isClean(d) && problems.length === 0,
    drift: d,
    undeclaredTriggers,
    undeclaredFunctions,
    undeclaredEventTriggers,
    unappliedMigrations: [],
    problems,
  };
}

/** `table.trigger` -> `trigger`; a bare name passes through. */
export function bareName(qualified: string): string {
  const dot = qualified.lastIndexOf(".");
  return dot === -1 ? qualified : qualified.slice(dot + 1);
}

/**
 * The catalog a database built ONLY from this repository's migrations must have.
 *
 * Derived from the Drizzle schema rather than recorded from a machine, and that is sound rather
 * than circular: `drizzle-kit generate` produces the migrations FROM this schema, and the
 * migration-drift CI job already fails if the two disagree. So "the schema" and "what the
 * migrations build" are the same statement, checked elsewhere.
 *
 * It is the fixture the tests judge, and it is what makes this gate's PASSING state observable
 * before anyone points it at a container.
 */
export function expectedFreshCatalog(journalTags: readonly { tag: string; hash: string }[]): LiveCatalog {
  return {
    tables: declaredTables().map((t) => ({ table: t.table, columns: [...t.columns].sort() })),
    triggers: [],
    functions: [],
    eventTriggers: [],
    recordedMigrationHashes: journalTags.map((e) => e.hash),
  };
}

export function render(v: CiVerdict, target: TargetClass): string[] {
  const L = [`[${SCRIPT}] target = ${target}`, ""];
  if (v.unappliedMigrations.length > 0) {
    L.push(`  ${v.unappliedMigrations.length} migration(s) NOT APPLIED — run db:migrate first:`);
    for (const t of v.unappliedMigrations.slice(0, 10)) L.push(`    ${t}`);
    if (v.unappliedMigrations.length > 10) L.push(`    ... and ${v.unappliedMigrations.length - 10} more`);
    L.push("");
    L.push("  Drift is NOT judged: every table those migrations create would report as MISSING,");
    L.push("  which is true and is the wrong diagnosis.");
    return L;
  }
  if (v.clean) {
    L.push("  CLEAN — the live schema is exactly what the Drizzle schema declares, and no");
    L.push("  trigger, function or event trigger exists that no migration creates.");
    return L;
  }
  L.push(`  ${v.problems.length} problem(s):`);
  for (const p of v.problems) L.push(`    ${p}`);
  L.push("");
  L.push("  Every one of these is a difference between this database and this repository. On a");
  L.push("  database built only from these migrations there should be none.");
  return L;
}

/** The journal, as (tag, hash) — the same hash `db:migrate` records. */
export function journalEntries(migrationsDir: string): { tag: string; hash: string }[] {
  const journal = JSON.parse(readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  // Drizzle hashes the migration FILE with sha256 — the same input `db:migrate` uses, so a hash
  // computed here matches a recorded row without re-implementing the migrator.
  return journal.entries.map((e) => ({
    tag: e.tag,
    hash: createHash("sha256").update(readFileSync(join(migrationsDir, `${e.tag}.sql`), "utf8")).digest("hex"),
  }));
}

async function readCatalog(url: string): Promise<LiveCatalog> {
  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    const cols = (await db.execute(
      dsql`SELECT c.relname AS tbl, a.attname AS col
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_attribute a ON a.attrelid = c.oid
            WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
            ORDER BY c.relname, a.attname`,
    )) as unknown as { tbl: string; col: string }[];
    const byTable = new Map<string, string[]>();
    for (const r of cols) (byTable.get(r.tbl) ?? byTable.set(r.tbl, []).get(r.tbl)!).push(r.col);

    const trg = (await db.execute(
      dsql`SELECT c.relname || '.' || t.tgname AS name
             FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE NOT t.tgisinternal AND n.nspname = 'public' ORDER BY 1`,
    )) as unknown as { name: string }[];
    const fns = (await db.execute(
      dsql`SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public'
              AND NOT EXISTS (SELECT 1 FROM pg_depend d
                               WHERE d.objid = p.oid AND d.classid = 'pg_proc'::regclass AND d.deptype = 'e')
            ORDER BY 1`,
    )) as unknown as { name: string }[];
    const evt = (await db.execute(
      dsql`SELECT e.evtname AS name FROM pg_event_trigger e ORDER BY 1`,
    )) as unknown as { name: string }[];
    const recorded = (await db.execute(
      dsql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`,
    )) as unknown as { hash: string }[];

    return {
      tables: [...byTable.entries()].map(([table, columns]) => ({ table, columns: columns.sort() })).sort((a, b) => a.table.localeCompare(b.table)),
      triggers: trg.map((t) => t.name),
      functions: fns.map((f) => f.name),
      eventTriggers: evt.map((e) => e.name),
      recordedMigrationHashes: recorded.map((r) => r.hash),
    };
  } finally {
    await sql.end();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (f: string): string | undefined =>
    argv.find((a) => a.startsWith(`${f}=`))?.slice(f.length + 1);

  const migrationsDir = join(__dirname, "..", "migrations");
  const journal = journalEntries(migrationsDir);
  const routines = declaredRoutines(migrationsDir);
  const declared = declaredTables();

  // CAPTURE, WHICH IS NOT JUDGEMENT, AND SITS BEFORE THE GUARD FOR THAT REASON.
  //
  // The design doc states one thing this mode does not prove: "the SQL that turns a real
  // database into a catalog is only exercised by running it." Everything else is proved from
  // `expectedFreshCatalog()` and mutations of it, which exercises the VERDICT and never the
  // READ. `--catalog-out` was supposed to close that on the first container run — but it sits
  // after the target guard, so it can only ever run somewhere the gate already accepts, which
  // is nowhere yet.
  //
  // Capture is read-only and says nothing about whether the schema is correct, so the guard's
  // argument — "this question is only meaningful about a database built solely from these
  // migrations" — does not apply to it. Judgement stays guarded; recording does not. A captured
  // production catalog can then be judged with `--from-json`, which is how the gate gets
  // exercised against a production-LIKE state without ever being pointed at production.
  const captureOnly = arg("--capture-only");
  if (captureOnly !== undefined) {
    const url = process.env["DATABASE_URL"];
    if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);
    if (existsSync(captureOnly)) {
      console.error(`  refusing to overwrite ${captureOnly} — evidence is never replaced.`);
      process.exit(1);
    }
    const seen = await readCatalog(url);
    writeFileSync(captureOnly, `${JSON.stringify(seen, null, 2)}
`, "utf8");
    console.log(`[${SCRIPT}] CAPTURE ONLY — no verdict was reached.`);
    console.log(`  target      ${hostClass(url)}`);
    console.log(`  tables      ${seen.tables.length}`);
    console.log(`  columns     ${seen.tables.reduce((n, t) => n + t.columns.length, 0)}`);
    console.log(`  routines    ${seen.triggers.length} trigger(s), ${seen.functions.length} function(s), ${seen.eventTriggers.length} event trigger(s)`);
    console.log(`  recorded to ${captureOnly}`);
    console.log(`  Judge it with --from-json=${captureOnly}. Capturing is not passing.`);
    return;
  }

  const fromJson = arg("--from-json");
  let catalog: LiveCatalog;
  let target: TargetClass;

  if (fromJson !== undefined) {
    catalog = JSON.parse(readFileSync(fromJson, "utf8")) as LiveCatalog;
    target = "LOCAL DOCKER"; // a recorded catalog has no target; the guard does not apply
    console.log(`[${SCRIPT}] judging a RECORDED catalog: ${fromJson}`);
  } else {
    const url = process.env["DATABASE_URL"];
    if (!url) throw new Error(`[${SCRIPT}] DATABASE_URL is not set`);
    target = hostClass(url);
    if (!isCiSafeTarget(target)) {
      // The refusal IS the design. See the header: this mode's question is only meaningful about
      // a database built solely from these migrations.
      console.error(`[${SCRIPT}] REFUSING: target is ${target}, and this mode judges only ${CI_SAFE_TARGETS.join("/")}.`);
      console.error(`  A production database legitimately carries objects this repository does not declare.`);
      console.error(`  Use \`pnpm db:audit:live-drift\` there — it reports the same drift as questions, not as a verdict.`);
      process.exit(2);
    }
    catalog = await readCatalog(url);
    const out = arg("--catalog-out");
    if (out !== undefined) {
      if (existsSync(out)) {
        console.error(`  refusing to overwrite ${out} — evidence is never replaced.`);
        process.exit(1);
      }
      writeFileSync(out, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
      console.log(`  catalog recorded to ${out}`);
    }
  }

  const verdict = ciVerdict(catalog, declared, routines, journal);
  for (const line of render(verdict, target)) console.log(line);
  if (!verdict.clean) process.exitCode = 1;
}

if (process.argv[1]?.includes("live-drift-ci")) void main();
