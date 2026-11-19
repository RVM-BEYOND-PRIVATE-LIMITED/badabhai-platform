/**
 * Migration 0191 — `outbound_signals` widened for the withdrawal of an undone selected / hired
 * mark (#2771): `outbound_signals_kind_chk` admits `applicant_mark_withdrawn`, and
 * `outbound_signals_failure_chk` the three cancel reasons of a chain row RVM never needed.
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is the
 * half they do not see:
 *
 *   1. ADDITIVE — two CHECKs re-added wider; no column, no index, no row, no other table.
 *   2. THE VOCABULARIES — each re-added CHECK keeps every value 0167 allowed (so no stored row can
 *      fail the re-add) and closes exactly what it was written with (a FROZEN record).
 *   3. THE TRIPWIRE — the LIVE model's CHECKs are exactly the shared constants, so a kind or a
 *      failure code added to a constant turns this red until a migration follows.
 *   4. THE HEADER — deploy order (before the SWITCH, after 0167), locks, the verification query
 *      and the rollback are written down.
 *
 * Nothing here connects to a database — it reads the committed SQL, journal and snapshot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  OUTBOUND_SIGNAL_FAILURES,
  OUTBOUND_SIGNAL_KINDS,
  outboundSignals,
} from "./schema/outbound-signal";

const TAG = "0191_outbound_signal_withdrawals";
const KIND_CHK = "outbound_signals_kind_chk";
const FAILURE_CHK = "outbound_signals_failure_chk";
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

/** The quoted values of one re-added CHECK, in order. */
function listed(constraint: string): string[] {
  const chk = FLAT.match(new RegExp(`ADD CONSTRAINT "${constraint}" CHECK[^;]*`))?.[0] ?? "";
  return [...chk.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
}

/** What 0167 allowed: a frozen copy (0167's own test pins its SQL to the same lists). */
const KINDS_0167 = ["applicant_selected", "applicant_hired"];
const FAILURES_0167 = [
  "not_configured",
  "timeout",
  "network",
  "http_status",
  "contract",
  "not_available",
  "rejected",
  "link_inactive",
  "context_missing",
  "mark_undone",
  "worker_inactive",
  "abandoned",
];

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("reads a migration that re-adds both CHECKs", () => {
    for (const chk of [KIND_CHK, FAILURE_CHK]) {
      expect(FLAT).toContain(`DROP CONSTRAINT "${chk}"`);
      expect(FLAT).toContain(`ADD CONSTRAINT "${chk}"`);
      expect(listed(chk).length).toBeGreaterThan(0);
    }
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("APPLY BEFORE THE SWITCH");
    expect(DDL).not.toContain("APPLY BEFORE THE SWITCH");
  });
});

describe("0191 is additive", () => {
  it("alters only outbound_signals, and drops only the two CHECKs it re-adds", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1] as string);
    expect([...new Set(altered)]).toEqual(["outbound_signals"]);
    const dropped = [...FLAT.matchAll(/DROP CONSTRAINT "([a-z_]+)"/g)].map((m) => m[1]);
    expect(dropped.sort()).toEqual([FAILURE_CHK, KIND_CHK].sort());
    expect([...FLAT.matchAll(/ADD CONSTRAINT/g)]).toHaveLength(2);
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

describe("the widened CHECKs", () => {
  it("the kind CHECK: FROZEN to the three kinds it was written with", () => {
    expect(listed(KIND_CHK)).toEqual([...KINDS_0167, "applicant_mark_withdrawn"]);
  });

  it("the failure CHECK: FROZEN to 0167's twelve codes plus #2771's three, and still nullable", () => {
    expect(listed(FAILURE_CHK)).toEqual([
      ...FAILURES_0167,
      "mark_never_sent",
      "mark_restored",
      "mark_already_sent",
    ]);
    expect(FLAT).toContain(`"outbound_signals"."last_failure" IS NULL OR`);
  });

  it("keeps every value 0167 allowed, so no stored row can fail the re-add", () => {
    for (const kind of KINDS_0167) expect(listed(KIND_CHK)).toContain(kind);
    for (const failure of FAILURES_0167) expect(listed(FAILURE_CHK)).toContain(failure);
  });
});

describe("the LIVE model and the snapshot agree with the migration", () => {
  const dialect = new PgDialect();
  const config = getTableConfig(outboundSignals);
  const modelValues = (name: string): string[] => {
    const check = config.checks.find((c) => c.name === name);
    if (!check) throw new Error(`${name} is not on the model`);
    return [...dialect.sqlToQuery(check.value).sql.matchAll(/'([a-z_]+)'/g)].map(
      (m) => m[1] as string,
    );
  };

  it("the model's CHECKs close exactly the shared constants", () => {
    // THE TRIPWIRE THAT OUTLIVES THIS MIGRATION: a kind or a failure code added to a constant
    // turns this red until the CHECK (and so a new migration) follows.
    expect(modelValues(KIND_CHK)).toEqual([...OUTBOUND_SIGNAL_KINDS]);
    expect(modelValues(FAILURE_CHK)).toEqual([...OUTBOUND_SIGNAL_FAILURES]);
  });

  it("0191's snapshot builds on its predecessor's and records both widened CHECKs", () => {
    const at = JOURNAL.entries.findIndex((e) => e.tag === TAG);
    const previousTag = JOURNAL.entries[at - 1]!.tag;
    const prev = snapshot(previousTag.slice(0, 4));
    const next = snapshot("0191");
    expect(next.prevId).toBe(prev.id);
    const table = next.tables["public.outbound_signals"]!;
    expect(table.checkConstraints[KIND_CHK]!.value).toContain("'applicant_mark_withdrawn'");
    expect(table.checkConstraints[FAILURE_CHK]!.value).toContain(
      "'mark_never_sent', 'mark_restored', 'mark_already_sent'",
    );
  });
});

describe("the header", () => {
  it("states the switch, the slot order, the lock_timeout, the verification query and the rollback", () => {
    expect(RAW).toContain("OUTBOUND_SIGNALS_ROLLOUT");
    expect(RAW).toContain("Apply 0167 first");
    expect(RAW).toContain("SET LOCAL lock_timeout");
    expect(RAW).toContain("pg_get_constraintdef");
    expect(RAW).toContain(
      `CHECK ("outbound_signals"."kind" IN ('applicant_selected', 'applicant_hired'));`,
    );
  });
});

describe("the journal", () => {
  // Located by TAG, not `.at(-1)`, so a later migration cannot fail this file (the 0126 lesson).
  it("records 0191 at idx 191, with a `when` above its predecessor's", () => {
    const at = JOURNAL.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    const entry = JOURNAL.entries[at]!;
    const previous = JOURNAL.entries[at - 1]!;
    expect(entry.idx).toBe(191);
    expect(entry.when).toBeGreaterThan(previous.when);
  });
});
