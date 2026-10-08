import { describe, expect, it } from "vitest";
import {
  CENSUS_QUERIES,
  censusCount,
  flipGate,
  type CensusQuery,
  type CensusResult,
} from "./audit-org-tenancy";

/**
 * ADR-0053 census (plan §6). The counting is Postgres's job; what is pinned here is what makes
 * the census safe to run against production and honest to read: every statement is a read, no
 * PII column is selected, C5 sizes every tenant table, and the flip gate fails on exactly the
 * must-be-zero checks.
 */

/** Statement keywords that write, lock or change state. None may appear in a census query. */
const WRITE_KEYWORDS =
  /\b(insert|update|delete|merge|upsert|alter|create|drop|truncate|grant|revoke|copy|lock|call|do|vacuum|analyze|refresh|reindex|cluster|comment|security|set|reset|listen|notify|prepare|execute)\b/i;

/** Column names that would carry PII (ciphertext counts: it is the PII at rest). */
const PII_COLUMNS = /\b(\w*_enc|\w*_hash|email\w*|phone\w*|full_name|org_name\w*|name)\b/i;

describe("db:audit:org-tenancy — read-only by construction", () => {
  it("runs exactly the plan §6 checks, once each", () => {
    expect(CENSUS_QUERIES.map((q) => q.id)).toEqual([
      "C1",
      "C2",
      "C3",
      "C4",
      "C5",
      "C6a",
      "C6b",
      "C7",
      "C8",
    ]);
  });

  it.each(CENSUS_QUERIES.map((q) => [q.id, q] as const))(
    "%s is one SELECT (or WITH … SELECT) and names no write keyword",
    (_id, q) => {
      const text = q.sql.trim();
      expect(text).toMatch(/^(select|with)\b/i);
      expect(text).not.toMatch(WRITE_KEYWORDS);
      // One statement: a `;` would let a second one ride along.
      expect(text).not.toContain(";");
    },
  );

  it.each(CENSUS_QUERIES.map((q) => [q.id, q] as const))(
    "%s selects no PII column (ids, enums, counts and accepted_at only)",
    (_id, q) => {
      expect(q.sql).not.toMatch(PII_COLUMNS);
    },
  );

  it("C5 sizes every class-A tenant table a team member could own under their own key", () => {
    const c5 = CENSUS_QUERIES.find((q) => q.id === "C5")!;
    for (const table of [
      "job_postings",
      "jobs",
      "unlocks",
      "resume_disclosures",
      "posting_plans",
      "posting_boosts",
      "payer_capacity",
      "payment_orders",
      "credit_ledger",
      "payer_credits",
      "agency_invites",
      "referral_links",
    ]) {
      expect(c5.sql, table).toMatch(new RegExp(`FROM ${table} WHERE`));
    }
  });

  it("the write-keyword screen is not vacuous: it rejects a write", () => {
    expect("UPDATE payer_members SET status = 'removed'").toMatch(WRITE_KEYWORDS);
    expect("DELETE FROM payer_orgs").toMatch(WRITE_KEYWORDS);
    expect("SELECT email_enc FROM payers").toMatch(PII_COLUMNS);
  });
});

describe("db:audit:org-tenancy — counting and the flip gate", () => {
  const q = (id: string): CensusQuery => CENSUS_QUERIES.find((x) => x.id === id)!;
  const result = (id: string, rows: Record<string, unknown>[]): CensusResult => ({
    query: q(id),
    rows,
  });
  const clean = (): CensusResult[] => CENSUS_QUERIES.map((query) => ({ query, rows: [] }));

  it("counts rows, except a tally (C5, C8), which sums its n column", () => {
    expect(censusCount(result("C2", [{ a: 1 }, { a: 2 }]))).toBe(2);
    expect(
      censusCount(
        result("C5", [
          { t: "unlocks", n: "3" },
          { t: "jobs", n: 4 },
        ]),
      ),
    ).toBe(7);
    // A tally of zeros is zero, though it always returns one row per table.
    expect(
      censusCount(
        result("C8", [
          { t: "unlocks", n: 0 },
          { t: "payer_credits", n: 0 },
        ]),
      ),
    ).toBe(0);
  });

  it("passes on a clean census", () => {
    expect(flipGate(clean())).toEqual({ pass: true, failing: [] });
  });

  it.each(["C2", "C3", "C4", "C6a", "C6b"])("fails when %s is non-zero", (id) => {
    const results = clean().map((r) => (r.query.id === id ? { ...r, rows: [{ x: 1 }] } : r));
    expect(flipGate(results)).toEqual({ pass: false, failing: [id] });
  });

  it("does NOT fail on C1, C5, C7 or C8: those are recorded (C5 is what O-2 ruled on)", () => {
    const results = clean().map((r) =>
      ["C1", "C7"].includes(r.query.id)
        ? { ...r, rows: [{ x: 1 }] }
        : ["C5", "C8"].includes(r.query.id)
          ? { ...r, rows: [{ t: "unlocks", n: 9 }] }
          : r,
    );
    expect(flipGate(results)).toEqual({ pass: true, failing: [] });
  });
});
