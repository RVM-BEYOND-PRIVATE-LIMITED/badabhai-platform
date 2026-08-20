/**
 * The 0081 rehearsal's pure parts — and one test that is not about this file at all.
 *
 * `the rehearsal matches the migration` reads `0081_rls_lock_seven_tables.sql` off disk and
 * asserts the statements this runner executes are the statements that file will apply. Without
 * it the tool proves something adjacent to the migration rather than the migration: someone
 * edits the SQL, the rehearsal keeps passing against its own private copy of the plan, and the
 * evidence file says YES about a migration that no longer exists in that form.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DML,
  R39_TABLES,
  REVOKED_ROLES,
  expectationFor,
  lockStatements,
  sameState,
} from "./verify-rls-lock";

const MIGRATION = readFileSync(
  join(__dirname, "..", "migrations", "0081_rls_lock_seven_tables.sql"),
  "utf8",
);
/** The DDL, with the header comment block stripped — every line of it starts with `--`. */
const DDL = MIGRATION.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("R39_TABLES — the seven, and which half each belongs to", () => {
  it("is exactly the seven tables db:audit:rls reports as open", () => {
    expect(R39_TABLES.map((t) => t.table)).toEqual([
      "agency_kyc",
      "agency_payout_accruals",
      "agency_payout_requests",
      "agency_profiles",
      "employer_profiles",
      "payer_capabilities",
      "payer_member_invites",
    ]);
  });

  it("classifies the three 0048 declares separately from the four that are unmodelled", () => {
    // The class decides whether "table absent" is a failure or the expected state. Getting it
    // backwards would make a fresh database fail the rehearsal, or make production pass it by
    // skipping a table that is really there.
    const byClass = (c: string): string[] => R39_TABLES.filter((t) => t.cls === c).map((t) => t.table);
    expect(byClass("declared-by-0048")).toEqual([
      "agency_kyc",
      "agency_payout_accruals",
      "agency_payout_requests",
    ]);
    expect(byClass("unmodelled")).toEqual([
      "agency_profiles",
      "employer_profiles",
      "payer_capabilities",
      "payer_member_invites",
    ]);
  });
});

describe("lockStatements — what the rehearsal actually runs", () => {
  it("is ENABLE, then FORCE, then one REVOKE per Data-API role", () => {
    expect(lockStatements("t")).toEqual([
      'ALTER TABLE "t" ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE "t" FORCE ROW LEVEL SECURITY',
      'REVOKE ALL ON TABLE "t" FROM anon',
      'REVOKE ALL ON TABLE "t" FROM authenticated',
      'REVOKE ALL ON TABLE "t" FROM service_role',
      'REVOKE ALL ON TABLE "t" FROM PUBLIC',
    ]);
  });

  it("revokes from PUBLIC as well as the three named roles", () => {
    // The broadest grant of all, and the one a hand-written tail is likeliest to forget.
    expect(lockStatements("t").filter((s) => s.startsWith("REVOKE"))).toHaveLength(4);
    expect(lockStatements("t").some((s) => s.endsWith("FROM PUBLIC"))).toBe(true);
  });

  it("puts FORCE after ENABLE, because FORCE on a table without RLS is meaningless", () => {
    const s = lockStatements("t");
    expect(s.findIndex((x) => x.includes("ENABLE"))).toBeLessThan(s.findIndex((x) => x.includes("FORCE")));
  });
});

describe("the rehearsal matches the migration it rehearses", () => {
  it("names every one of the seven tables in 0081's DDL", () => {
    for (const { table } of R39_TABLES) {
      expect(DDL, `0081 must mention ${table}`).toContain(table);
    }
  });

  it("0081 REVOKEs from all four roles for each Section-A table, unconditionally", () => {
    for (const { table, cls } of R39_TABLES) {
      if (cls !== "declared-by-0048") continue;
      for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
        expect(DDL).toContain(`REVOKE ALL ON TABLE "${table}" FROM ${role};`);
      }
      expect(DDL).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`);
    }
  });

  it("guards every Section-B table behind to_regclass, so a fresh database does not abort", () => {
    // The four exist only on production. An unconditional ALTER would fail migration 0081 in
    // CI, in the e2e job, and on every new developer's machine — and take the slot with it.
    expect(DDL).toContain("to_regclass");
    for (const { table, cls } of R39_TABLES) {
      if (cls !== "unmodelled") continue;
      expect(DDL).toContain(`'${table}'`);
      expect(DDL, `${table} must not be locked by an unguarded ALTER`).not.toContain(
        `ALTER TABLE "${table}"`,
      );
    }
  });

  it("adds no table, column, index or constraint — 0081 is a permissions change only", () => {
    expect(DDL).not.toMatch(/\bCREATE\s+(TABLE|INDEX|UNIQUE)\b/i);
    expect(DDL).not.toMatch(/\bADD\s+(COLUMN|CONSTRAINT)\b/i);
    expect(DDL).not.toMatch(/\bDROP\b/i);
  });

  it("grants nothing to anyone", () => {
    // The one line that would turn a lock into a hole. `REVOKE` contains no `GRANT`, so this
    // matches only a real grant statement.
    expect(DDL).not.toMatch(/\bGRANT\b/i);
  });
});

describe("REVOKED_ROLES / DML — the sharp form of the grant check", () => {
  it("drops PUBLIC, which has_table_privilege does not accept as a role name", () => {
    expect([...REVOKED_ROLES]).toEqual(["anon", "authenticated", "service_role"]);
  });

  it("checks write and TRUNCATE, not only SELECT", () => {
    // A table that revoked SELECT and kept INSERT would pass a SELECT-only probe while
    // remaining writable by any PostgREST role.
    expect([...DML]).toEqual(["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES"]);
  });
});

describe("sameState — the after-rollback comparison", () => {
  const s = { exists: true, enabled: true, forced: false, grantedRoles: ["anon", "postgres"] };

  it("accepts an identical state whatever the grant order", () => {
    expect(sameState(s, { ...s, grantedRoles: ["postgres", "anon"] })).toBe(true);
  });

  it.each([
    ["exists", { ...s, exists: false }],
    ["enabled", { ...s, enabled: false }],
    ["forced", { ...s, forced: true }],
    ["a lost grant", { ...s, grantedRoles: ["postgres"] }],
    ["an extra grant", { ...s, grantedRoles: ["anon", "postgres", "service_role"] }],
  ])("rejects a change in %s", (_what, other) => {
    expect(sameState(s, other)).toBe(false);
  });
});

describe("expectationFor", () => {
  it("reads as a claim about the named table", () => {
    expect(expectationFor("agency_kyc:lock-takes")).toContain("agency_kyc");
    expect(expectationFor("agency_kyc:owner-can-read")).toMatch(/backend's own connection/);
    expect(expectationFor("agency_kyc:privileges-zero")).toMatch(/no DML privilege/);
  });

  it("falls back to the id rather than inventing a claim it cannot make", () => {
    expect(expectationFor("something-else")).toBe("something-else");
  });
});
