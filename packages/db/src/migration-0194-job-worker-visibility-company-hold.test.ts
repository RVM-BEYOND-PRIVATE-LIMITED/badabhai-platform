/**
 * Migration 0194 — `job_posting_worker_visibility.origin` admits `company_rvm_trade` (#2956
 * follow-up, Prakash 19 Nov 2026): a company job in a trade RVM trains waits, hidden from BadaBhai
 * workers, until an admin decides where it shows.
 *
 * What this file pins (the drizzle model and CI's drift check cover the table-vs-model half):
 *
 *   1. ADDITIVE — one CHECK re-added wider; no column, no index, no row, no other table.
 *   2. THE VOCABULARY — the re-added CHECK keeps both values 0184 allowed and is FROZEN to the three
 *      it was written with.
 *   3. THE TRIPWIRE — the LIVE model's CHECK is exactly the shared constant, so an origin added to
 *      it turns this red until a migration follows.
 *   4. THE HEADER — deploy order (before the SWITCH), locks, the verification query and the
 *      rollback are written down.
 *
 * Nothing here connects to a database — it reads the committed SQL, journal and snapshot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  CAMPUS_WORKER_VISIBILITY_ORIGINS,
  JOB_WORKER_VISIBILITY_ORIGINS,
  isCampusWorkerVisibilityOrigin,
  jobPostingWorkerVisibility,
} from "./schema/job-worker-visibility";

const TAG = "0194_job_worker_visibility_company_hold";
const T = "job_posting_worker_visibility";
const ORIGIN_CHK = "jpwv_origin_chk";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");
/** Statements with comments stripped, so the header's prose cannot satisfy a DDL assertion. */
const DDL = RAW.replace(/--[^\n]*/g, " ");
const FLAT = DDL.replace(/\s+/g, " ");

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

interface SnapshotTable {
  checkConstraints: Record<string, { value: string }>;
}
const snapshot = (
  n: string,
): { id: string; prevId: string; tables: Record<string, SnapshotTable> } =>
  JSON.parse(
    readFileSync(join(__dirname, "..", "migrations", "meta", `${n}_snapshot.json`), "utf8"),
  );

/** The quoted values of the re-added CHECK, in order. */
function listed(): string[] {
  const head = `ADD CONSTRAINT "${ORIGIN_CHK}" CHECK`;
  const start = FLAT.indexOf(head);
  if (start < 0) return [];
  const end = FLAT.indexOf(";", start);
  return [...FLAT.slice(start, end < 0 ? undefined : end).matchAll(/'([a-z_]+)'/g)].map(
    (m) => m[1] as string,
  );
}

/** What 0184 allowed: a frozen copy (0184's own test pins its SQL to the same list). */
const ORIGINS_0184 = ["campus_posted", "campus_imported"];

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("reads a migration that re-adds the origin CHECK", () => {
    expect(FLAT).toContain(`DROP CONSTRAINT "${ORIGIN_CHK}"`);
    expect(FLAT).toContain(`ADD CONSTRAINT "${ORIGIN_CHK}"`);
    expect(listed().length).toBeGreaterThan(0);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("APPLY BEFORE ADMIN_JOB_AUDIENCE_ENABLED IS TURNED ON");
    expect(DDL).not.toContain("APPLY BEFORE");
  });
});

describe("0194 is additive", () => {
  it(`alters only ${T}, and drops only the CHECK it re-adds`, () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1] as string);
    expect([...new Set(altered)]).toEqual([T]);
    const dropped = [...FLAT.matchAll(/DROP CONSTRAINT "([a-z_]+)"/g)].map((m) => m[1]);
    expect(dropped).toEqual([ORIGIN_CHK]);
    expect([...FLAT.matchAll(/ADD CONSTRAINT/g)]).toHaveLength(1);
  });

  it("drops no column or table, writes no rows, and never touches the ledger", () => {
    for (const verb of [
      "DROP TABLE",
      "DROP COLUMN",
      "DROP INDEX",
      "CREATE INDEX",
      "CREATE TABLE",
      "ADD COLUMN",
      "TRUNCATE",
      "DELETE FROM",
      "INSERT INTO",
      'UPDATE "',
      "NOT VALID",
    ]) {
      expect(FLAT.toUpperCase()).not.toContain(verb);
    }
    expect(FLAT).not.toContain("__drizzle_migrations");
  });
});

describe("the widened CHECK", () => {
  it("is FROZEN to 0184's two origins plus company_rvm_trade", () => {
    expect(listed()).toEqual([...ORIGINS_0184, "company_rvm_trade"]);
  });
});

describe("the LIVE model and the snapshot agree with the migration", () => {
  it("the model's CHECK closes exactly the shared constant", () => {
    const check = getTableConfig(jobPostingWorkerVisibility).checks.find(
      (c) => c.name === ORIGIN_CHK,
    );
    if (!check) throw new Error(`${ORIGIN_CHK} is not on the model`);
    const values = [...new PgDialect().sqlToQuery(check.value).sql.matchAll(/'([a-z_]+)'/g)].map(
      (m) => m[1] as string,
    );
    expect(values).toEqual([...JOB_WORKER_VISIBILITY_ORIGINS]);
  });

  it("Campus origin is exactly the two Campus values, never the company hold", () => {
    expect([...CAMPUS_WORKER_VISIBILITY_ORIGINS]).toEqual(ORIGINS_0184);
    expect(isCampusWorkerVisibilityOrigin("company_rvm_trade")).toBe(false);
    expect(isCampusWorkerVisibilityOrigin(null)).toBe(false);
    for (const o of ORIGINS_0184) {
      expect(isCampusWorkerVisibilityOrigin(o as "campus_posted")).toBe(true);
    }
  });

  it("0194's snapshot builds on its predecessor's and records the widened CHECK", () => {
    const at = JOURNAL.entries.findIndex((e) => e.tag === TAG);
    const prev = snapshot(JOURNAL.entries[at - 1]!.tag.slice(0, 4));
    const next = snapshot("0194");
    expect(next.prevId).toBe(prev.id);
    expect(next.tables[`public.${T}`]!.checkConstraints[ORIGIN_CHK]!.value).toContain(
      "'company_rvm_trade'",
    );
  });
});

describe("the header", () => {
  it("states the switch, the lock_timeout, the verification query and the rollback", () => {
    expect(RAW).toContain("ADMIN_JOB_AUDIENCE_ENABLED");
    expect(RAW).toContain("SET LOCAL lock_timeout");
    expect(RAW).toContain("pg_get_constraintdef");
    expect(RAW).toContain(`CHECK ("${T}"."origin" IN ('campus_posted', 'campus_imported'));`);
  });
});

describe("the journal", () => {
  // Located by TAG, not `.at(-1)`, so a later migration cannot fail this file (the 0126 lesson).
  it("records 0194 at idx 194, with a `when` above its predecessor's", () => {
    const at = JOURNAL.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    expect(JOURNAL.entries[at]!.idx).toBe(194);
    expect(JOURNAL.entries[at]!.when).toBeGreaterThan(JOURNAL.entries[at - 1]!.when);
  });
});
