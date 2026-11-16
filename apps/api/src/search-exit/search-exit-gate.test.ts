import { describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { TenantKey } from "../payers/payer-tenant-scope";
import {
  appliedToTenantStatement,
  leftSearchStatement,
  searchExitRefuses,
  type SearchExitExecutor,
} from "./search-exit-gate";

/**
 * #2753 item 6 — `searchExitRefuses`, the unlock rule for a worker who left company search. What it
 * reads, in what order, and only on the handle it is given (the unlock transaction's `tx`). That the
 * SQL means what it says against real application rows is the DB gate's.
 */
const dialect = new PgDialect();
const WORKER = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222" as TenantKey;
const ON = { SEARCH_EXIT_ENABLED: true };

/** A `tx` that answers the exit read and the applicant read from two flags. */
function tx(state: { hidden: boolean; applied: boolean }) {
  const reads: string[] = [];
  const execute = vi.fn(async (statement: SQL) => {
    const { sql } = dialect.sqlToQuery(statement);
    if (sql.includes("FROM worker_search_exits")) {
      reads.push("exit");
      return state.hidden ? [{ hidden: 1 }] : [];
    }
    if (sql.includes("FROM applications a")) {
      reads.push("applied");
      return state.applied ? [{ member: 1 }] : [];
    }
    throw new Error(`unexpected statement: ${sql}`);
  });
  return { handle: { execute } as unknown as SearchExitExecutor, execute, reads };
}

describe("searchExitRefuses", () => {
  it.each([
    [undefined, "no config"],
    [{ SEARCH_EXIT_ENABLED: false }, "the switch off"],
  ])("OFF (%s, %s): never refuses and reads NOTHING", async (config, _label) => {
    const t = tx({ hidden: true, applied: false });
    expect(await searchExitRefuses(t.handle, config, WORKER, TENANT)).toBe(false);
    expect(t.execute).not.toHaveBeenCalled();
  });

  it("on, still in search: allowed after ONE read (the applicant read never runs)", async () => {
    const t = tx({ hidden: false, applied: false });
    expect(await searchExitRefuses(t.handle, ON, WORKER, TENANT)).toBe(false);
    expect(t.reads).toEqual(["exit"]);
  });

  it("on, left search, an applicant of this company: allowed", async () => {
    const t = tx({ hidden: true, applied: true });
    expect(await searchExitRefuses(t.handle, ON, WORKER, TENANT)).toBe(false);
    expect(t.reads).toEqual(["exit", "applied"]);
  });

  it("on, left search, NOT an applicant of this company: refused", async () => {
    const t = tx({ hidden: true, applied: false });
    expect(await searchExitRefuses(t.handle, ON, WORKER, TENANT)).toBe(true);
    expect(t.reads).toEqual(["exit", "applied"]);
  });

  it("a read error propagates (the unlock transaction fails closed; nothing is decided open)", async () => {
    const handle = {
      execute: vi.fn(async () => {
        throw new Error("connection reset");
      }),
    } as unknown as SearchExitExecutor;
    await expect(searchExitRefuses(handle, ON, WORKER, TENANT)).rejects.toThrow("connection reset");
  });
});

describe("the statements", () => {
  it("the exit read is one primary-key read, parameterised", () => {
    const q = dialect.sqlToQuery(leftSearchStatement(WORKER));
    expect(q.sql).toContain("FROM worker_search_exits x WHERE x.worker_id = $1::uuid");
    expect(q.params).toEqual([WORKER]);
  });

  it("the applicant read is the applicant feeds' membership, asked across the tenant's postings", () => {
    const q = dialect.sqlToQuery(appliedToTenantStatement(WORKER, TENANT));
    const flat = q.sql.replace(/\s+/g, " ");
    // An `applied` decision (a skip or a withdrawn application is not one).
    expect(flat).toContain("a.action = 'applied'");
    // Either arm, owned by the TENANT key (the `findOwnedJobRef` rule).
    expect(flat).toContain("LEFT JOIN job_postings jp ON jp.id = a.job_posting_id");
    expect(flat).toContain("LEFT JOIN jobs j ON j.id = a.job_id");
    expect(flat).toMatch(/jp\.payer_id = \$\d+::uuid OR \( j\.payer_id = \$\d+::uuid AND EXISTS/);
    // The agency list ranks from worker_profiles, so an applier without one is not on it.
    expect(flat).toContain(
      "EXISTS (SELECT 1 FROM worker_profiles wp WHERE wp.worker_id = a.worker_id)",
    );
    // Frozen workers are not applicants on any payer surface.
    expect(flat).toContain("w.deletion_scheduled_at IS NULL");
    expect(flat).toContain("w.status <> 'suspended'");
    expect(q.params).toEqual([WORKER, TENANT, TENANT]);
  });

  it("neither statement names a consent table: leaving search is not a consent question", () => {
    for (const s of [leftSearchStatement(WORKER), appliedToTenantStatement(WORKER, TENANT)]) {
      expect(dialect.sqlToQuery(s).sql).not.toContain("worker_consents");
    }
  });
});
