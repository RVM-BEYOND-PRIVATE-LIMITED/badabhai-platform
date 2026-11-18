/**
 * Migration 0166 — `payer_applicant_stages_stage_chk` widened to admit `selected` and `hired`
 * (#2747 item 7, brief 4B.8).
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is the
 * half they do not see:
 *
 *   1. ADDITIVE — one CHECK re-added wider; no column, no row, no other table.
 *   2. THE VOCABULARY — the CHECK closes exactly the five stages, and keeps every stage 0134
 *      allowed (`APPLICANT_STAGES_V1`), so no stored row can fail the re-add.
 *   3. THE TRIPWIRE — a sixth stage added to `APPLICANT_STAGES` turns the LIVE-model test red
 *      until a migration follows.
 *   4. THE HEADER — deploy order (before the SWITCH, not the deploy), locks, the verification
 *      query and the rollback are written down.
 *
 * Nothing here connects to a database — it reads the committed SQL, journal and snapshot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { APPLICANT_OUTCOME_STAGES, APPLICANT_STAGES, APPLICANT_STAGES_V1 } from "@badabhai/types";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { payerApplicantStages } from "./schema/payer-applicant-stage";

const TAG = "0166_payer_applicant_outcome_stages";
const CHK = "payer_applicant_stages_stage_chk";
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

const chk = FLAT.match(new RegExp(`ADD CONSTRAINT "${CHK}" CHECK[^;]*`))?.[0] ?? "";
const listed = [...chk.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("reads a migration that re-adds the stage CHECK", () => {
    expect(FLAT).toContain(`DROP CONSTRAINT "${CHK}"`);
    expect(FLAT).toContain(`ADD CONSTRAINT "${CHK}"`);
    expect(listed.length).toBeGreaterThan(0);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("APPLY BEFORE THE SWITCH");
    expect(DDL).not.toContain("APPLY BEFORE THE SWITCH");
  });
});

describe("0166 is additive", () => {
  it("alters only payer_applicant_stages, and drops only the CHECK it re-adds", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1] as string);
    expect([...new Set(altered)]).toEqual(["payer_applicant_stages"]);
    const dropped = [...FLAT.matchAll(/DROP CONSTRAINT "([a-z_]+)"/g)].map((m) => m[1]);
    expect(dropped).toEqual([CHK]);
    expect([...FLAT.matchAll(/ADD CONSTRAINT/g)]).toHaveLength(1);
  });

  it("drops no column or table, writes no rows, and never touches the ledger", () => {
    for (const verb of [
      "DROP TABLE",
      "DROP COLUMN",
      "DROP INDEX",
      "CREATE INDEX",
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
  it("closes EXACTLY the five stages declared when it was written — a FROZEN record", () => {
    // A migration file never changes, so this pins it to a literal; the LIVE agreement with the
    // shared constant is the model test below.
    expect(listed).toEqual(["new", "shortlist", "passed", "selected", "hired"]);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("keeps every stage 0134 allowed, so no stored row can fail the re-add", () => {
    for (const stage of APPLICANT_STAGES_V1) expect(listed).toContain(stage);
  });

  it("adds exactly the outcome stages", () => {
    expect(listed.filter((s) => !(APPLICANT_STAGES_V1 as readonly string[]).includes(s))).toEqual([
      ...APPLICANT_OUTCOME_STAGES,
    ]);
  });
});

describe("the LIVE model and the snapshot agree with the migration", () => {
  const dialect = new PgDialect();
  const config = getTableConfig(payerApplicantStages);

  it("the model's stage CHECK closes exactly APPLICANT_STAGES", () => {
    // THE TRIPWIRE THAT OUTLIVES THIS MIGRATION: a sixth stage added to the shared constant
    // turns this red until the CHECK (and so a new migration) follows.
    const check = config.checks.find((c) => c.name === CHK);
    if (!check) throw new Error(`${CHK} is not on the model`);
    const stages = [...dialect.sqlToQuery(check.value).sql.matchAll(/'([a-z_]+)'/g)].map(
      (m) => m[1],
    );
    expect(stages).toEqual([...APPLICANT_STAGES]);
  });

  it("0166's snapshot builds on its predecessor's and records the widened CHECK", () => {
    const at = JOURNAL.entries.findIndex((e) => e.tag === TAG);
    const previousTag = JOURNAL.entries[at - 1]!.tag;
    const prev = snapshot(previousTag.slice(0, 4));
    const next = snapshot("0166");
    expect(next.prevId).toBe(prev.id);
    const table = next.tables["public.payer_applicant_stages"]!;
    expect(table.checkConstraints[CHK]!.value).toContain("'selected', 'hired'");
  });
});

describe("the header", () => {
  it("states the switch, the lock_timeout, the verification query and the three-stage rollback", () => {
    expect(RAW).toContain("OUTCOME_STAGES_ROLLOUT");
    expect(RAW).toContain("SET LOCAL lock_timeout");
    expect(RAW).toContain("pg_get_constraintdef");
    expect(RAW).toContain(
      `CHECK ("payer_applicant_stages"."stage" IN ('new', 'shortlist', 'passed'));`,
    );
  });
});

describe("the journal", () => {
  // Located by TAG, not `.at(-1)`, so a later migration cannot fail this file (the 0126 lesson).
  it("records 0166 at idx 166, with a `when` above its predecessor's", () => {
    const at = JOURNAL.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    const entry = JOURNAL.entries[at]!;
    const previous = JOURNAL.entries[at - 1]!;
    expect(entry.idx).toBe(166);
    expect(entry.when).toBeGreaterThan(previous.when);
  });
});
