/**
 * The adoption verifier — the rules that decide whether a migration may be recorded as applied
 * without running its DDL.
 *
 * The centrepiece is `the 0048 regression`. It reads the real `0048_empty_archangel.sql` off
 * disk and checks it against a synthetic catalog reproducing production exactly as it was found
 * on 2026-08-20: every table, column, index, constraint and RLS flag present, and the Data-API
 * roles still holding every grant. The old checker called that clean and recorded 0048 as
 * applied. This asserts it is refused, and refused FOR THE GRANT — so R39 cannot recur silently
 * on some future migration whose REVOKE tail is skipped the same way.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  adoptionProblems,
  expectationCount,
  normalizeType,
  parseMigration,
  pgIdent,
  splitTopLevel,
  vacuous,
  verifyAgainst,
  EFFECT_VERIFIERS,
  effectVerifierFor,
  type Expect,
  type LiveCatalog,
} from "./migration-adoption";
import { DATA_API_ROLES, R39_TABLES } from "./schema-contract";

const MIGRATIONS = join(__dirname, "..", "migrations");
const read = (tag: string): string => readFileSync(join(MIGRATIONS, `${tag}.sql`), "utf8");

/** An empty database. Every expectation fails against it, which is the point. */
const emptyCatalog: LiveCatalog = {
  tables: new Set(),
  columns: new Map(),
  indexes: new Set(),
  constraints: new Set(),
  rlsEnabled: new Set(),
  rlsForced: new Set(),
  grants: new Set(),
};

/** A catalog that satisfies everything a migration declares — optionally minus/plus some grants. */
function catalogSatisfying(e: Expect, grants: string[] = []): LiveCatalog {
  return {
    tables: new Set(e.tables),
    columns: new Map(e.columns),
    indexes: new Set([...e.indexes].map(pgIdent)),
    constraints: new Set([...e.constraints].map(pgIdent)),
    rlsEnabled: new Set([...e.rlsEnabled, ...e.rlsForced]),
    rlsForced: new Set(e.rlsForced),
    grants: new Set(grants),
  };
}

describe("parseMigration — what a migration claims", () => {
  it("reads tables and their column types out of CREATE TABLE", () => {
    const e = parseMigration(`CREATE TABLE "t" (\n\t"id" uuid PRIMARY KEY NOT NULL,\n\t"n" integer DEFAULT 0\n);`);
    expect([...e.tables]).toEqual(["t"]);
    expect(e.columns.get("t.id")).toBe("uuid");
    expect(e.columns.get("t.n")).toBe("integer");
  });

  it("reads REVOKE ALL as a claim that the role holds nothing", () => {
    const e = parseMigration(`REVOKE ALL ON TABLE "t" FROM anon;\nREVOKE ALL PRIVILEGES ON "u" FROM service_role;`);
    expect([...e.revoked].sort()).toEqual(["t:anon", "u:service_role"]);
  });

  it("ignores a PARTIAL revoke, because 'holds nothing' is then the wrong assertion", () => {
    // REVOKE INSERT leaves SELECT standing. Recording it as "no grant" would be a false claim,
    // and a false claim is worse than an absent one.
    expect(parseMigration(`REVOKE INSERT ON TABLE "t" FROM anon;`).revoked.size).toBe(0);
  });

  it("lowercases the role, so PUBLIC and public are one claim", () => {
    expect([...parseMigration(`REVOKE ALL ON TABLE "t" FROM PUBLIC;`).revoked]).toEqual(["t:public"]);
  });

  it("flags dynamic SQL", () => {
    expect(parseMigration(`DO $$ BEGIN EXECUTE 'x'; END $$;`).dynamicSql).toBe(true);
    expect(parseMigration(`CREATE TABLE "t" (\n\t"id" uuid\n);`).dynamicSql).toBe(false);
  });

  it("does not see anything inside a comment", () => {
    expect(parseMigration(`-- REVOKE ALL ON TABLE "t" FROM anon;\n-- DO $$`).revoked.size).toBe(0);
    expect(parseMigration(`-- DO $$ something`).dynamicSql).toBe(false);
  });

  it("drops a constraint that is added and then dropped, and keeps one dropped then re-added", () => {
    expect(parseMigration(`ALTER TABLE "t" ADD CONSTRAINT "c" CHECK (1=1);\nALTER TABLE "t" DROP CONSTRAINT "c";`).constraints.size).toBe(0);
    expect([...parseMigration(`ALTER TABLE "t" DROP CONSTRAINT "c";\nALTER TABLE "t" ADD CONSTRAINT "c" CHECK (1=1);`).constraints]).toEqual(["c"]);
  });

  it("never pairs one statement's table with a later statement's column", () => {
    // The `[^;]*?` span. A `[\s\S]*?` one crossed statement boundaries and invented three
    // PARTIAL verdicts on the first full-depth run.
    const e = parseMigration(
      `ALTER TABLE "a" ENABLE ROW LEVEL SECURITY;\nALTER TABLE "b" ADD COLUMN "c" text;`,
    );
    expect([...e.columns.keys()]).toEqual(["b.c"]);
  });
});

describe("normalizeType — fail closed on anything unrecognised", () => {
  it.each([
    ["uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL", "uuid"],
    ["boolean DEFAULT false NOT NULL", "boolean"],
    ["varchar(64)", "character varying"],
    ["numeric(10, 2)", "numeric"],
    ["vector(768)", "USER-DEFINED"],
    ["text[]", "ARRAY"],
    ["timestamp with time zone", "timestamp with time zone"],
  ])("maps %s", (declared, want) => {
    expect(normalizeType(declared)).toBe(want);
  });

  it("RAISES on a type it does not know, rather than treating it as a match", () => {
    // A permissive fallback here is how a partly-applied migration gets adopted: the column
    // exists with the wrong type and the checker shrugs.
    expect(() => normalizeType("geography(Point,4326)")).toThrow(/refusing to guess/);
  });
});

describe("pgIdent / splitTopLevel", () => {
  it("truncates an identifier at 63 bytes, as Postgres does", () => {
    // A longer generated FK name is stored truncated, so comparing the full name reports a
    // false MISSING — it did, four times.
    const long = "x".repeat(80);
    expect(pgIdent(long)).toHaveLength(63);
    expect(pgIdent("short")).toBe("short");
  });

  it("splits only on commas outside parentheses", () => {
    expect(splitTopLevel(`"a" numeric(10, 2), "b" text`).map((s) => s.trim())).toEqual([
      '"a" numeric(10, 2)',
      '"b" text',
    ]);
  });
});

describe("verifyAgainst — one problem per unmet claim", () => {
  const e = parseMigration(
    `CREATE TABLE "t" (\n\t"id" uuid NOT NULL\n);\nCREATE INDEX "t_idx" ON "t" ("id");\n` +
      `ALTER TABLE "t" ADD CONSTRAINT "t_chk" CHECK (1=1);\n` +
      `ALTER TABLE "t" ENABLE ROW LEVEL SECURITY;\nALTER TABLE "t" FORCE ROW LEVEL SECURITY;\n` +
      `REVOKE ALL ON TABLE "t" FROM anon;`,
  );

  it("is silent when the database matches", () => {
    expect(verifyAgainst(e, catalogSatisfying(e))).toEqual([]);
  });

  it("reports every class of absence against an empty database", () => {
    const problems = verifyAgainst(e, emptyCatalog);
    expect(problems).toContain("table t MISSING");
    expect(problems).toContain("column t.id MISSING");
    expect(problems).toContain("index t_idx MISSING");
    expect(problems).toContain("constraint t_chk MISSING");
    expect(problems).toContain("t: RLS not enabled");
    expect(problems).toContain("t: RLS not FORCED");
  });

  it("catches a column of the right NAME and the wrong TYPE", () => {
    const live = { ...catalogSatisfying(e), columns: new Map([["t.id", "text"]]) };
    expect(verifyAgainst(e, live)).toContain("column t.id is text, expected uuid");
  });

  it("catches a REVOKE that never took — the grant is still held", () => {
    expect(verifyAgainst(e, catalogSatisfying(e, ["t:anon"]))).toEqual([
      "t: anon STILL HOLDS a grant this migration revokes",
    ]);
  });

  it("tolerates a grant to a role the migration says nothing about", () => {
    // The owner's own grant is on every table. Flagging it would make every migration dirty.
    expect(verifyAgainst(e, catalogSatisfying(e, ["t:postgres"]))).toEqual([]);
  });
});

describe("vacuous — nothing to check is not the same as everything checks out", () => {
  it("is true for a migration made only of backfills", () => {
    const e = parseMigration(`UPDATE "t" SET x = 1 WHERE x IS NULL;`);
    expect(expectationCount(e)).toBe(0);
    expect(vacuous(e)).toBe(true);
  });

  it("is true for a pure DROP", () => {
    expect(vacuous(parseMigration(`DROP TABLE "t";`))).toBe(true);
  });

  it("is false for a migration that only revokes — the REVOKE is now checkable", () => {
    // 0004 and 0009 are exactly this shape. Before REVOKE was parsed they were vacuous, which
    // means the two migrations that established the platform's whole RLS posture were
    // adoptable on no evidence.
    expect(vacuous(parseMigration(`REVOKE ALL ON TABLE "t" FROM anon;`))).toBe(false);
  });
});

describe("adoptionProblems — the complete verdict", () => {
  it("passes a migration whose every claim is met", () => {
    const sql = `CREATE TABLE "t" (\n\t"id" uuid NOT NULL\n);`;
    expect(adoptionProblems(sql, catalogSatisfying(parseMigration(sql)))).toEqual([]);
  });

  it("REFUSES a vacuous migration even against a perfect database", () => {
    const problems = adoptionProblems(`UPDATE "t" SET x = 1;`, emptyCatalog);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/declares nothing this tool can check/);
  });

  it("REFUSES dynamic SQL, whose effect cannot be read from the file", () => {
    const sql = `CREATE TABLE "t" (\n\t"id" uuid\n);\nDO $$ BEGIN EXECUTE 'ALTER TABLE t ADD COLUMN y text'; END $$;`;
    expect(adoptionProblems(sql, catalogSatisfying(parseMigration(sql)))[0]).toMatch(/dynamic SQL/);
  });

  it("puts a refusal BEFORE the object list, because they mean different things", () => {
    // "cannot establish the answer" is not "the answer is no". A reader who saw a clean object
    // list first would take the file as verified.
    const sql = `DO $$ BEGIN END $$;\nCREATE TABLE "t" (\n\t"id" uuid\n);`;
    const problems = adoptionProblems(sql, emptyCatalog);
    expect(problems[0]).toMatch(/dynamic SQL/);
    expect(problems.slice(1)).toContain("table t MISSING");
  });

  it("reports a parse failure instead of pretending the migration is clean", () => {
    expect(adoptionProblems(`CREATE TABLE "t" (\n\t"g" geography(Point,4326)\n);`, emptyCatalog)[0]).toMatch(
      /parse failed/,
    );
  });
});

describe("the 0048 regression — the migration that was adopted with its REVOKEs unapplied", () => {
  const sql = read("0048_empty_archangel");
  const e = parseMigration(sql);

  it("declares FORCE and four REVOKEs for each of its three tables", () => {
    for (const t of ["agency_kyc", "agency_payout_accruals", "agency_payout_requests"]) {
      expect(e.rlsForced.has(t), `${t} FORCE`).toBe(true);
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(e.revoked.has(`${t}:${role}`), `${t}:${role}`).toBe(true);
      }
    }
  });

  it("is REFUSED against production as measured on 2026-08-20", () => {
    // Every object present, every RLS flag set, and the Data-API roles still holding grants.
    // This is the exact state the old checker called clean.
    const production = catalogSatisfying(e, [
      "agency_kyc:anon",
      "agency_kyc:authenticated",
      "agency_kyc:service_role",
      "agency_payout_accruals:anon",
      "agency_payout_accruals:authenticated",
      "agency_payout_accruals:service_role",
      "agency_payout_requests:anon",
      "agency_payout_requests:authenticated",
      "agency_payout_requests:service_role",
    ]);
    const problems = adoptionProblems(sql, production);
    expect(problems).toHaveLength(9);
    for (const p of problems) expect(p).toMatch(/STILL HOLDS a grant this migration revokes/);
  });

  it("passes once the grants are gone — the refusal is about the grant, nothing else", () => {
    expect(adoptionProblems(sql, catalogSatisfying(e))).toEqual([]);
  });
});

describe("the five migrations awaiting adoption (0076–0080)", () => {
  const TAGS = [
    "0076_canonical_domain_skill_taxonomy",
    "0077_ai_cost_running_totals",
    "0078_unresolved_phrase_job_domain_id",
    "0079_journey_read_indexes",
    "0080_worker_feedback",
  ];

  it.each(TAGS)("%s parses and declares something checkable", (tag) => {
    // The hardening must not block the adoption it was written alongside: a new refusal that
    // catches these five would turn a journal fix into a hand-reconciliation.
    const e = parseMigration(read(tag));
    expect(vacuous(e)).toBe(false);
    expect(e.dynamicSql).toBe(false);
  });

  it.each(TAGS)("%s is clean against a database that satisfies it", (tag) => {
    const sql = read(tag);
    expect(adoptionProblems(sql, catalogSatisfying(parseMigration(sql)))).toEqual([]);
  });

  it.each(TAGS)("%s is REFUSED against a database missing its objects", (tag) => {
    // The property that matters most: adoption cannot mark a genuinely-absent migration applied.
    expect(adoptionProblems(read(tag), emptyCatalog).length).toBeGreaterThan(0);
  });
});

describe("effect verifiers — the one narrow way past the dynamic-SQL refusal", () => {
  const TAG = "0082_rls_lock_seven_tables";

  /** A catalog in which 0082 IS applied: all seven locked, nothing granted. */
  function locked(): LiveCatalog {
    return {
      tables: new Set(R39_TABLES.map((t) => t.table)),
      columns: new Map(),
      indexes: new Set(),
      constraints: new Set(),
      rlsEnabled: new Set(R39_TABLES.map((t) => t.table)),
      rlsForced: new Set(R39_TABLES.map((t) => t.table)),
      grants: new Set(),
    };
  }

  it("registers 0082, and the registration checks a non-zero number of facts", () => {
    // Property 3 in the header: a verifier that asserts nothing would reproduce the exact
    // "nothing to check counted as everything checked" defect `vacuous` exists to prevent.
    const v = effectVerifierFor(TAG);
    expect(v).toBeDefined();
    expect(v!.assertions).toBeGreaterThan(0);
    expect(v!.assertions).toBe(R39_TABLES.length * (2 + DATA_API_ROLES.length));
  });

  it("registers ONLY the migrations that genuinely need it — per-migration, not a relaxation", () => {
    // The list is asserted EXACTLY, not by membership: the hatch's whole safety argument is
    // that it is opened one migration at a time, for a stated reason, and an assertion that
    // merely checks 0082 is present would let a general relaxation land beside it unnoticed.
    //
    // 0084 joined it because its `auth.users` foreign key is `to_regclass`-guarded — that
    // schema exists on Supabase and nowhere else — while everything else in the file is plain
    // text the static parse still checks in full.
    expect(EFFECT_VERIFIERS.map((v) => v.tag)).toEqual([
      TAG,
      "0084_model_gap_db_21_payer_onboarding",
    ]);
    for (const v of EFFECT_VERIFIERS) {
      expect(v.assertions).toBeGreaterThan(0);
      expect(v.why.length).toBeGreaterThan(20);
    }
  });

  it("still refuses dynamic SQL when the migration has no verifier", () => {
    const sql = `DO $$ BEGIN EXECUTE 'ALTER TABLE x ENABLE ROW LEVEL SECURITY'; END $$;`;
    expect(adoptionProblems(sql, emptyCatalog, "0099_not_registered").join(" ")).toContain("dynamic SQL");
  });

  it("adopts 0082 against a database where all seven are actually locked", () => {
    expect(adoptionProblems(read(TAG), locked(), TAG)).toEqual([]);
  });

  it("REFUSES 0082 when the tables are absent — 42 facts, none of them satisfied", () => {
    // The runbook property: adoption cannot mark a migration applied whose effects are not there.
    const problems = adoptionProblems(read(TAG), emptyCatalog, TAG);
    expect(problems.length).toBeGreaterThanOrEqual(R39_TABLES.length);
    expect(problems.join(" ")).toContain("table MISSING");
  });

  it("REFUSES 0082 when a single Data-API grant survives on a single table", () => {
    // The R39 failure mode itself: everything looks applied except the one control that matters.
    const live = locked();
    const grants = new Set(live.grants);
    grants.add("payer_capabilities:service_role");
    const problems = adoptionProblems(read(TAG), { ...live, grants }, TAG);
    expect(problems).toContain("payer_capabilities: service_role still holds a privilege — the REVOKE did not take");
  });

  it("REFUSES 0082 when RLS is enabled but not FORCED", () => {
    // ENABLE alone is decorative here: the owner is the only backend connection.
    const live = locked();
    const forced = new Set(live.rlsForced);
    forced.delete("agency_kyc");
    const problems = adoptionProblems(read(TAG), { ...live, rlsForced: forced }, TAG);
    expect(problems.join(" ")).toContain("agency_kyc: RLS is not FORCED");
  });

  it("covers the four GAP-DB-21 tables the static parse can never reach", () => {
    // Section B's tables appear ONLY inside the DO block, so `parseMigration` cannot see them.
    // If the verifier did not name them, adopting 0082 would assert nothing about four of seven.
    const parsed = parseMigration(read(TAG));
    const sectionB = R39_TABLES.filter((t) => t.cls === "declared-by-0084").map((t) => t.table);
    for (const t of sectionB) {
      expect([...parsed.rlsForced]).not.toContain(t);
      const live = locked();
      const forced = new Set(live.rlsForced);
      forced.delete(t);
      expect(adoptionProblems(read(TAG), { ...live, rlsForced: forced }, TAG).join(" ")).toContain(t);
    }
  });
});
