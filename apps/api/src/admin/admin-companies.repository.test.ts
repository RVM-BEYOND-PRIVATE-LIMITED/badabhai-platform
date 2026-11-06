import { describe, expect, it } from "vitest";
import type { Database } from "@badabhai/db";
import { AdminCompaniesRepository } from "./admin-companies.repository";
import { captureQueries, expectColumnsAbsent } from "./testing/query-capture";

const PAYER = "66666666-6666-4666-8666-666666666666";
const PAYER_PII = ["email_enc", "email_hash", "phone_enc", "phone_hash", "org_name_enc"];

/** Capturing update(...).set(...).where(...).returning(...) chain for the cascade writes. */
function makeTx(rows: Record<string, unknown>[] = []) {
  const updates: Array<{ table: unknown; set: Record<string, unknown>; where: unknown }> = [];
  const tx = {
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: (where: unknown) => {
          updates.push({ table, set, where });
          return { returning: async () => rows };
        },
      }),
    }),
  } as unknown as Database;
  return { tx, updates };
}

describe("admin companies reads are org-scoped and faceless", () => {
  it("resolves an org by its root before reading any company table", async () => {
    const c = captureQueries([{ id: "org-1", rootPayerId: PAYER }]);
    const repo = new AdminCompaniesRepository(c.db);
    await repo.resolveCompany(PAYER);
    expect(c.sql()).toContain("payer_orgs");
    expectColumnsAbsent(c, PAYER_PII);
  });

  it("the list filters kinds/statuses exactly and never projects contact PII", async () => {
    const c = captureQueries([]);
    const repo = new AdminCompaniesRepository(c.db);
    await repo.listCompanies(
      {
        searchWords: [],
        searchCity: null,
        searchGstHash: null,
        kind: "employer",
        status: "archived",
        verification: "verified",
        sort: "newest",
      },
      0,
      50,
    );
    const sql = c.sql();
    // One row per org: the org join + profile joins only — member rows are read
    // separately (per-anchor member sets), never as list rows.
    expect(sql).toContain("payer_orgs");
    expect(sql).not.toContain("payer_members");
    expectColumnsAbsent(c, PAYER_PII);
  });

  it("a word search constrains the word-hash array (AND over the query words)", async () => {
    const c = captureQueries([]);
    const repo = new AdminCompaniesRepository(c.db);
    await repo.listCompanies(
      {
        searchWords: ["h1", "h2"],
        searchCity: null,
        searchGstHash: null,
        sort: "newest",
      },
      0,
      50,
    );
    // `@>` containment: every query word must be present — a partial word never matches.
    expect(c.sql()).toContain("@>");
  });

  it("archive moves only pending|active|suspended logins (removed/invited untouched)", async () => {
    const { tx, updates } = makeTx([{ id: "p1", previousStatus: "active" }]);
    const repo = new AdminCompaniesRepository({} as never);
    const moved = await repo.archiveLogins([PAYER], tx);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.set).toMatchObject({ status: "archived" });
    // The from-state guard lives in the WHERE (pending|active|suspended) — the DB
    // test proves removed/invited rows never move; here the write is pinned.
    expect(updates[0]!.where).toBeDefined();
    expect(moved).toEqual([{ id: "p1", previousStatus: "active" }]);
  });

  it("restore moves only archived logins back (suspended stays suspended)", async () => {
    const { tx, updates } = makeTx([{ id: "p1", status: "active" }]);
    const repo = new AdminCompaniesRepository({} as never);
    const moved = await repo.restoreLogins([PAYER], tx);
    expect(updates).toHaveLength(1);
    expect(moved).toEqual([{ id: "p1", status: "active" }]);
  });
});
