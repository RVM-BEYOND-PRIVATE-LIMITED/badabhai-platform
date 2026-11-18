import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import {
  formatSharedPhonesReport,
  groupSharedPhones,
  parseReportSharedPayerPhonesArgs,
  readSharedPayerPhones,
  type SharedPhoneRow,
} from "./report-shared-payer-phones.cli";

/**
 * #2754 item 3 — the READ-ONLY report of phones two or more company accounts share. A fake
 * database stands in for Postgres: what is pinned is that the read runs in a READ ONLY
 * transaction, that the report groups by phone without ever printing the phone or its hash, and
 * that the CLI has no write switch at all.
 */
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const D = "dddddddd-0000-4000-8000-000000000004";
const E = "eeeeeeee-0000-4000-8000-000000000005";

const ROWS: SharedPhoneRow[] = [
  {
    phone_hash: H1,
    payer_id: A,
    role: "employer",
    status: "active",
    created_at: "2026-01-02T03:04:05.000Z",
  },
  {
    phone_hash: H1,
    payer_id: B,
    role: "agent",
    status: "archived",
    created_at: new Date("2026-02-01T00:00:00.000Z"),
  },
  {
    phone_hash: H2,
    payer_id: C,
    role: "employer",
    status: "pending",
    created_at: "2026-03-01T00:00:00.000Z",
  },
  {
    phone_hash: H2,
    payer_id: D,
    role: "employer",
    status: "suspended",
    created_at: "2026-03-02T00:00:00.000Z",
  },
  {
    phone_hash: H2,
    payer_id: E,
    role: "employer",
    status: "active",
    created_at: "2026-03-03T00:00:00.000Z",
  },
];

/** A fake db: records the transaction config and the statement, answers `rows`. */
function fakeDb(rows: SharedPhoneRow[]) {
  const seen: { config?: unknown; query?: SQL } = {};
  const tx = {
    execute: vi.fn(async (query: SQL) => {
      seen.query = query;
      return rows;
    }),
  };
  const db = {
    transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>, config?: unknown) => {
      seen.config = config;
      return fn(tx);
    }),
  };
  return { db: db as unknown as Database, seen, tx };
}

describe("report-shared-payer-phones — the read", () => {
  it("runs inside a READ ONLY transaction", async () => {
    const f = fakeDb(ROWS);
    await expect(readSharedPayerPhones(f.db)).resolves.toEqual(ROWS);
    expect(f.seen.config).toEqual({ accessMode: "read only" });
    expect(f.tx.execute).toHaveBeenCalledTimes(1);
  });

  it("selects only phones held by two or more accounts, and writes nothing", async () => {
    const f = fakeDb([]);
    await readSharedPayerPhones(f.db);
    const { sql } = new PgDialect().sqlToQuery(f.seen.query!);
    const flat = sql.replace(/\s+/g, " ");
    expect(flat).toContain("HAVING count(*) > 1");
    expect(flat).toContain("WHERE phone_hash IS NOT NULL");
    for (const verb of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "ALTER", "CREATE", "DROP"]) {
      expect(flat.toUpperCase()).not.toContain(`${verb} `);
    }
    // It reads ids, role, status and age — never a phone ciphertext, an email or a name.
    expect(flat).not.toMatch(/phone_enc|email|org_name/);
  });
});

describe("report-shared-payer-phones — the printout", () => {
  it("counts the shared phones and the accounts, and groups them oldest first", () => {
    const report = groupSharedPhones(ROWS);
    expect(report.sharedPhones).toBe(2);
    expect(report.accounts).toBe(5);
    expect(report.groups.map((g) => g.map((a) => a.payerId))).toEqual([
      [A, B],
      [C, D, E],
    ]);
    expect(report.groups[0]![1]).toEqual({
      payerId: B,
      role: "agent",
      status: "archived",
      createdAt: "2026-02-01T00:00:00.000Z",
    });
  });

  it("prints ids, roles, statuses and dates — NEVER a phone hash", () => {
    const text = formatSharedPhonesReport(groupSharedPhones(ROWS)).join("\n");
    expect(text).toContain("shared_phones=2 accounts=5");
    expect(text).toContain("group 1 (2 accounts):");
    expect(text).toContain(
      `payer=${A} role=employer status=active created_at=2026-01-02T03:04:05.000Z`,
    );
    expect(text).toContain("group 2 (3 accounts):");
    expect(text).not.toContain(H1);
    expect(text).not.toContain(H2);
    expect(text).not.toMatch(/phone_hash|\+91/);
  });

  it("an empty result says the payers-level index can go on", () => {
    const text = formatSharedPhonesReport(groupSharedPhones([])).join("\n");
    expect(text).toContain("shared_phones=0 accounts=0");
    expect(text).toContain("unique index can be added");
  });

  it("a lone row (impossible from the query) is never reported as shared", () => {
    expect(groupSharedPhones([ROWS[0]!]).sharedPhones).toBe(0);
  });
});

describe("report-shared-payer-phones — there is no write switch", () => {
  it("takes no arguments", () => {
    expect(() => parseReportSharedPayerPhonesArgs([])).not.toThrow();
  });

  it.each([["--apply"], ["--i-am-authorised-to-write-to-production"], ["--batch=1"], ["stray"]])(
    "refuses %s",
    (arg) => {
      expect(() => parseReportSharedPayerPhonesArgs([arg])).toThrow();
    },
  );
});
