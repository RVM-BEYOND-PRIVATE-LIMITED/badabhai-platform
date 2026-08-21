/**
 * Migration 0084 — the properties that make it safe to run against a database that ALREADY has
 * every object it declares.
 *
 * This is the unusual case in the chain: 0084 creates four tables that production has had all
 * along and that no other environment has at all. So the interesting assertions are not "does
 * it create the right thing" — the schema file and `drizzle-kit` settle that — but "can it run
 * twice, and can it run where Supabase's `auth` schema does not exist".
 *
 * Everything here reads the committed SQL. Nothing connects to a database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { adoptionProblems, parseMigration } from "./migration-adoption";
import { DATA_API_ROLES, R39_TABLES } from "./schema-contract";

const TAG = "0084_model_gap_db_21_payer_onboarding";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");
/**
 * The STATEMENTS, with `--` comments stripped — the same first step `parseMigration` takes.
 *
 * This file's header is long and quotes its own SQL ("an unconditional CREATE TABLE would…",
 * "DROP TABLE is NOT the rollback"). Matching against the raw text would read those sentences
 * as statements, which is how a shape assertion turns into a prose assertion and starts failing
 * on an edit to a comment.
 */
const DDL = RAW.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

const FOUR = R39_TABLES.filter((t) => t.cls === "declared-by-0084").map((t) => t.table);

describe("0084 can run against a database that already has everything it declares", () => {
  it("creates every table with IF NOT EXISTS", () => {
    // Production has all four. A bare CREATE TABLE would abort the migration there — and
    // production is the one database where this file is meant to be a no-op.
    for (const t of FOUR) expect(DDL).toContain(`CREATE TABLE IF NOT EXISTS "${t}"`);
    expect(DDL.match(/CREATE\s+TABLE\b/gi)).toHaveLength(FOUR.length);
    expect(DDL).not.toMatch(/CREATE\s+TABLE\s+"/i); // i.e. never without the guard
  });

  it("creates every index with IF NOT EXISTS", () => {
    const creates = DDL.match(/CREATE\s+INDEX\b[^;]*/gi) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    for (const c of creates) expect(c).toMatch(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS/i);
  });

  it("drops each constraint before adding it, because Postgres has no ADD IF NOT EXISTS", () => {
    // The one shape that makes an ADD CONSTRAINT idempotent. All four tables hold 0 rows, so
    // the drop-and-re-add is instant and cannot fail validation.
    const added = [...DDL.matchAll(/ADD\s+CONSTRAINT\s+"?([\w]+)"?/gi)].map((m) => m[1]!);
    expect(added.length).toBeGreaterThan(0);
    for (const name of added) {
      expect(DDL, `${name} is added without a preceding DROP ... IF EXISTS`).toMatch(
        new RegExp(`DROP\\s+CONSTRAINT\\s+IF\\s+EXISTS\\s+"?${name}"?`, "i"),
      );
    }
  });

  it("uses the LIVE constraint names, not Drizzle's convention", () => {
    // `adopt-migrations.ts` verifies constraints against the live catalog BY NAME. A
    // Drizzle-flavoured `_fk` name would make this migration unadoptable against the single
    // database that already carries these constraints.
    for (const t of FOUR) expect(DDL).toContain(`"${t}_payer_id_fkey"`);
    expect(DDL).not.toMatch(/payer_id_payers_id_fk\b/);
  });
});

describe("0084 can run where Supabase does not", () => {
  it("guards the auth.users foreign key behind to_regclass", () => {
    // `auth.users` exists on Supabase and on no plain Postgres — not CI's e2e database, not a
    // developer's docker. An unconditional ADD would abort the migration there and take the
    // whole slot down, which is the failure 0082's Section B was already guarded against.
    expect(DDL).toContain("to_regclass('auth.users')");
    const guarded = /DO \$\$[\s\S]*?auth\.users\(id\)[\s\S]*?END \$\$;/.test(DDL);
    expect(guarded, "the auth.users FK must live inside the guarded DO block").toBe(true);
  });

  it("declares the column even though it does not declare the constraint", () => {
    // The split is deliberate: the model holds what is portable, the migration holds what is
    // environment-specific. The column is nullable and holds 0 rows either way.
    expect(DDL).toContain('"accepted_by_user_id" uuid');
  });
});

describe("0084 leaves a fresh database LOCKED, not open", () => {
  it("forces RLS and revokes every Data-API role, for all four", () => {
    // 0082 locked these on production behind a to_regclass guard, precisely because they
    // existed nowhere else. Now they will exist everywhere — and Supabase's default privileges
    // grant the Data-API roles at CREATE time. Without this section, 0084 would re-open on
    // every new environment exactly the hole 0082 closed.
    for (const t of FOUR) {
      expect(DDL).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY;`);
      expect(DDL).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY;`);
      for (const role of DATA_API_ROLES) {
        expect(DDL).toContain(`REVOKE ALL ON TABLE "${t}" FROM ${role};`);
      }
    }
  });

  it("grants nothing to anyone", () => {
    expect(DDL).not.toMatch(/^\s*GRANT\b/im);
  });

  it("drops no table and no column", () => {
    // The only DROPs in this file are the constraint drops that make the adds idempotent.
    expect(DDL).not.toMatch(/DROP\s+TABLE\b/i);
    expect(DDL).not.toMatch(/DROP\s+COLUMN\b/i);
    for (const m of DDL.matchAll(/DROP\s+(\w+)/gi)) expect(m[1]!.toUpperCase()).toBe("CONSTRAINT");
  });
});

describe("0084 is reachable by the migrator at all", () => {
  it("sits ABOVE the orphan row production already carries", () => {
    // THE HAZARD THIS EXISTS FOR. Drizzle's migrator is a HIGH-WATER MARK, not set membership:
    // it applies a file only when `folderMillis` exceeds the newest recorded `created_at`.
    // `0083_ai_call_traces` carries `when = 1787230000000` and was ALREADY APPLIED to
    // production before it merged — it is the row `--doctor` had been reporting as an
    // unexplained orphan. `drizzle-kit generate` minted 1787226261060 for this file, BELOW it,
    // so left alone 0084 would have been skipped silently and permanently.
    const entry = JOURNAL.entries.find((e) => e.tag === TAG);
    expect(entry).toBeDefined();
    expect(entry!.when).toBeGreaterThan(1787230000000);
  });

  it("is stamped above everything before it, and the journal is strictly increasing", () => {
    // A `when` raised by hand is exactly the edit that can put the journal out of order.
    // NOT "is the last entry" any more — 0085 lands after it. What has to hold is the property
    // that mattered all along: nothing before 0084 is stamped at or above it, because
    // drizzle-kit branches on a high-water mark and an entry below it is skipped forever.
    const whens = JOURNAL.entries.map((e) => e.when);
    for (let i = 1; i < whens.length; i += 1) expect(whens[i]!).toBeGreaterThan(whens[i - 1]!);
    const idx = JOURNAL.entries.findIndex((e) => e.tag === TAG);
    expect(idx).toBeGreaterThanOrEqual(0);
    for (const e of JOURNAL.entries.slice(0, idx)) expect(e.when).toBeLessThan(whens[idx]!);
  });
});

describe("0084 and the adoption path", () => {
  it("needs an effect verifier, because of the one guarded statement", () => {
    // Everything else in the file is plain text. The DO block is what trips the dynamic-SQL
    // refusal, and the verifier is the narrow, per-migration hatch past it.
    expect(parseMigration(DDL).dynamicSql).toBe(true);
    const problems = adoptionProblems(DDL, {
      tables: new Set(),
      columns: new Map(),
      indexes: new Set(),
      constraints: new Set(),
      rlsEnabled: new Set(),
      rlsForced: new Set(),
      grants: new Set(),
      functionGrants: new Set(),
      defaultFunctionAcls: new Set(),
      deleteForensicsColumns: new Set(),
    });
    // Without a tag there is no verifier, so the refusal still stands — the hatch is opened by
    // naming the migration, never by the file's own contents.
    expect(problems.join(" ")).toContain("dynamic SQL");
  });

  it("still fails adoption against an empty catalog even WITH its verifier", () => {
    // Property 4 of the hatch: a verifier must be able to fail. A migration whose effects are
    // absent must never be recordable as applied.
    const problems = adoptionProblems(
      DDL,
      {
        tables: new Set(),
        columns: new Map(),
        indexes: new Set(),
        constraints: new Set(),
        rlsEnabled: new Set(),
        rlsForced: new Set(),
        grants: new Set(),
        functionGrants: new Set(),
        defaultFunctionAcls: new Set(),
        deleteForensicsColumns: new Set(),
      },
      TAG,
    );
    expect(problems.length).toBeGreaterThan(0);
    for (const t of FOUR) expect(problems.join(" ")).toContain(t);
  });
});
