import { describe, expect, it, vi } from "vitest";
import {
  CENSUS_QUERIES,
  censusCount,
  flipGate,
  runCensus,
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
      "C5b",
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
      // The agency money tables (ADR-0053 §4, O-5; PR #2175 review F5). Expected 0 while
      // AGENCY_PAYOUTS_ENABLED is off — a member's own KYC / accrual / request would stay theirs.
      "agency_kyc",
      "agency_payout_accruals",
      "agency_payout_requests",
    ]) {
      expect(c5.sql, table).toMatch(new RegExp(`FROM ${table} WHERE`));
    }
  });

  it("C5's headline counts ROWS only; the credits balance is its own line, C5b (review L4)", () => {
    const c5 = CENSUS_QUERIES.find((q) => q.id === "C5")!;
    const c5b = CENSUS_QUERIES.find((q) => q.id === "C5b")!;
    // Summing a balance into a row count makes the headline meaningless (rows + credits).
    expect(c5.sql).not.toMatch(/sum\s*\(\s*balance/i);
    expect(c5b.sql).toMatch(/sum\s*\(\s*balance/i);
    expect(c5b.sql).toMatch(/FROM payer_credits WHERE/);
    expect(c5b.rule).toBe("record");
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

describe("db:audit:org-tenancy — the run is ONE read-only transaction (review L5)", () => {
  /** A postgres.js stand-in: `begin(mode, fn)` hands `fn` a transaction; the outer client refuses queries. */
  function fakeSql(opts: { readOnly?: string; bypass?: boolean } = {}) {
    const tx = {
      unsafe: vi.fn(async (text: string) => {
        if (/transaction_read_only/.test(text))
          return [{ transaction_read_only: opts.readOnly ?? "on" }];
        if (/rolbypassrls/.test(text))
          return [{ who: "postgres", bypass_rls: opts.bypass ?? true }];
        return [{ marker: text.slice(0, 12) }];
      }),
    };
    const sql = {
      begin: vi.fn(async (_mode: string, fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
      unsafe: vi.fn(async () => {
        throw new Error("a census query ran OUTSIDE the read-only transaction");
      }),
    };
    return { sql, tx };
  }

  it("opens ONE `read only` transaction and runs every check inside it", async () => {
    const { sql, tx } = fakeSql();
    const results = await runCensus(sql as never);
    expect(sql.begin).toHaveBeenCalledTimes(1);
    expect(sql.begin.mock.calls[0]![0]).toBe("read only");
    expect(sql.unsafe).not.toHaveBeenCalled();
    const ran = tx.unsafe.mock.calls.map((c) => c[0]);
    for (const q of CENSUS_QUERIES) expect(ran).toContain(q.sql);
    expect(results.map((r) => r.query.id)).toEqual(CENSUS_QUERIES.map((q) => q.id));
  });

  it("refuses to measure when the transaction does not report read-only", async () => {
    const { sql, tx } = fakeSql({ readOnly: "off" });
    await expect(runCensus(sql as never)).rejects.toThrow(/read-only/);
    expect(tx.unsafe.mock.calls.map((c) => c[0])).not.toContain(CENSUS_QUERIES[0]!.sql);
  });

  it("refuses a role that does not bypass RLS (a zero would be a permission artifact)", async () => {
    const { sql } = fakeSql({ bypass: false });
    await expect(runCensus(sql as never)).rejects.toThrow(/does not bypass RLS/);
  });
});
