/**
 * Migration 0130 — `generated_resumes_generation_trigger_chk` widened to admit 'chat_edit'
 * (ADR-0046 Phase 1, O6/O14).
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is the
 * half they do not see:
 *
 *   1. ADDITIVE — one CHECK re-added wider; no column, no row, no other table.
 *   2. THE VOCABULARY — the CHECK closes exactly `RESUME_GENERATION_TRIGGERS`, keeps every trigger
 *      0125 allowed, and still tolerates NULL (pre-0125 rows).
 *   3. THE TRIPWIRE — a sixth trigger added to the shared constant turns the LIVE-model test red
 *      until a migration follows.
 *   4. THE HEADER — deploy order (before the FLAG, not the deploy), locks and the rollback are
 *      written down.
 *
 * Nothing here connects to a database — it reads the committed SQL, journal and snapshot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { RESUME_GENERATION_TRIGGERS } from "@badabhai/types";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { generatedResumes } from "./schema/profile";

const TAG = "0130_resume_generation_trigger_chat_edit";
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

/** The four triggers 0125 allowed. Every one must survive, or a stored row fails the re-add. */
const TRIGGERS_0125 = ["profile_confirmed", "manual", "chat_update_accepted", "ops_regenerate"] as const;

const chk = FLAT.match(/ADD CONSTRAINT "generated_resumes_generation_trigger_chk" CHECK[^;]*/)?.[0] ?? "";
const listed = [...chk.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("reads a migration that re-adds the trigger CHECK", () => {
    expect(FLAT).toContain('DROP CONSTRAINT "generated_resumes_generation_trigger_chk"');
    expect(FLAT).toContain('ADD CONSTRAINT "generated_resumes_generation_trigger_chk"');
    expect(listed.length).toBeGreaterThan(0);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    // The header's ROLLBACK block spells out the old four-trigger CHECK.
    expect(RAW).toContain("APPLY BEFORE THE FLAG");
    expect(DDL).not.toContain("APPLY BEFORE THE FLAG");
  });
});

describe("0130 is additive", () => {
  it("alters only generated_resumes, and drops only the CHECK it re-adds", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1] as string);
    expect([...new Set(altered)]).toEqual(["generated_resumes"]);
    const dropped = [...FLAT.matchAll(/DROP CONSTRAINT "([a-z_]+)"/g)].map((m) => m[1]);
    expect(dropped).toEqual(["generated_resumes_generation_trigger_chk"]);
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
    ]) {
      expect(FLAT.toUpperCase()).not.toContain(verb);
    }
    expect(FLAT).not.toContain("__drizzle_migrations");
  });
});

describe("the widened CHECK", () => {
  it("closes EXACTLY the five triggers declared when it was written — a FROZEN record", () => {
    // A migration file never changes, so this pins it to a literal; the LIVE agreement with the
    // shared constant is the model test below.
    expect([...listed].sort()).toEqual(
      ["chat_edit", "chat_update_accepted", "manual", "ops_regenerate", "profile_confirmed"].sort(),
    );
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("keeps every trigger 0125 allowed, so no stored row can fail the re-add", () => {
    for (const trigger of TRIGGERS_0125) expect(listed).toContain(trigger);
  });

  it("still tolerates NULL — the pre-0125 rows the column was added for", () => {
    expect(chk).toContain('"generation_trigger" IS NULL');
  });
});

describe("the LIVE model and the snapshot agree with the migration", () => {
  const dialect = new PgDialect();
  const config = getTableConfig(generatedResumes);

  it("the model's trigger CHECK closes exactly RESUME_GENERATION_TRIGGERS", () => {
    // THE TRIPWIRE THAT OUTLIVES THIS MIGRATION: a sixth trigger added to the shared constant
    // turns this red until the CHECK (and so a new migration) follows.
    const check = config.checks.find((c) => c.name === "generated_resumes_generation_trigger_chk");
    if (!check) throw new Error("generated_resumes_generation_trigger_chk is not on the model");
    const triggers = [...dialect.sqlToQuery(check.value).sql.matchAll(/'([a-z_]+)'/g)].map(
      (m) => m[1],
    );
    expect(triggers.sort()).toEqual([...RESUME_GENERATION_TRIGGERS].sort());
  });

  it("0130's snapshot builds on 0129's and records the widened CHECK", () => {
    const prev = snapshot("0129");
    const next = snapshot("0130");
    expect(next.prevId).toBe(prev.id);
    const table = next.tables["public.generated_resumes"]!;
    expect(table.checkConstraints["generated_resumes_generation_trigger_chk"]!.value).toContain(
      "'chat_edit'",
    );
  });
});

describe("the header", () => {
  it("states the flags, the lock_timeout and a rollback that restores the four-trigger list", () => {
    expect(RAW).toContain("CHAT_COMPANION_V2_EDIT_ENABLED");
    expect(RAW).toContain("SET LOCAL lock_timeout");
    expect(RAW).toContain(
      `"generated_resumes"."generation_trigger" IN ('profile_confirmed', 'manual', 'chat_update_accepted', 'ops_regenerate')`,
    );
  });
});

describe("the journal", () => {
  // Located by TAG, not `.at(-1)`, so a later migration cannot fail this file (the 0126 lesson).
  it("records 0130 at idx 130, after 0129, with a `when` above its predecessor's", () => {
    const at = JOURNAL.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    const entry = JOURNAL.entries[at]!;
    const previous = JOURNAL.entries[at - 1]!;
    expect(entry.idx).toBe(130);
    expect(previous.tag).toBe("0129_referral_links_resume_qr");
    expect(entry.when).toBeGreaterThan(previous.when);
  });
});
