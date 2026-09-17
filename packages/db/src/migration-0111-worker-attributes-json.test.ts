/**
 * Migration 0111 — `worker_attributes.value_json` and the `json` value kind (Layer A (c)).
 *
 * WHAT MATTERS HERE, beyond the drift check that compares model to SQL:
 *
 *   1. THE MIGRATION IS ADDITIVE FOR DATA. The new column is nullable with no default; each of
 *      the four ORIGINAL branches of `wa_value_present_chk` now also demands `value_json IS NULL`,
 *      which is true of every pre-0111 row. No row changes.
 *   2. THE INVARIANT IS RE-STATED, NOT RELAXED. Exactly one value column populated, and the one
 *      `value_kind` names — the fifth branch does not let a row carry both a json object and a
 *      scalar.
 *   3. `json` IS OBJECT-SHAPED. A list answer has its own kind and column; an array here would be
 *      a second representation of one fact.
 *
 * Nothing here connects to a database — it reads the committed SQL.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const TAG = "0111_worker_attributes_json";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");

const DDL = RAW.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const flat = (s: string): string => s.replace(/\s+/g, " ");
const FLAT = flat(DDL);

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("reads a migration that adds the column and both constraints", () => {
    expect(FLAT).toContain('ADD COLUMN "value_json" jsonb');
    expect(FLAT).toContain('CONSTRAINT "wa_value_json_shape_chk"');
    expect(FLAT).toContain('CONSTRAINT "wa_value_present_chk"');
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("worker_attributes.value_json: the `json` value kind");
    expect(DDL).not.toContain("the `json` value kind");
  });
});

describe("0111 is additive and data-preserving", () => {
  it("touches only worker_attributes, adds one column, and drops no data", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1] as string);
    expect([...new Set(altered)]).toEqual(["worker_attributes"]);
    expect((FLAT.match(/ADD COLUMN/g) ?? []).length).toBe(1);
    // The column is NULLABLE with no default — the ADD COLUMN line carries neither.
    const addColumn = FLAT.match(/ADD COLUMN "value_json"[^;]*/)?.[0] ?? "";
    expect(addColumn).not.toContain("NOT NULL");
    expect(addColumn).not.toContain("DEFAULT");
    for (const verb of ["DROP COLUMN", "DROP TABLE", "TRUNCATE", "UPDATE "]) {
      expect(FLAT.toUpperCase()).not.toContain(verb);
    }
  });

  it("states the rollback in the header", () => {
    expect(RAW).toContain('DROP COLUMN "value_json"');
  });

  it("holds the only 0111 slot in the journal, contiguous with 0110", () => {
    const entry = JOURNAL.entries.find((e) => e.tag === TAG);
    expect(entry).toBeDefined();
    expect(entry?.idx).toBe(111);
    expect(JOURNAL.entries.filter((e) => e.idx === 111)).toHaveLength(1);
    const sorted = [...JOURNAL.entries].sort((a, b) => a.idx - b.idx);
    const at = sorted.findIndex((e) => e.tag === TAG);
    expect(sorted[at - 1]?.idx).toBe(110);
  });
});

describe("the invariant, restated", () => {
  it("wa_value_present_chk has a branch per kind, and every branch excludes the others", () => {
    const chk = FLAT.match(/"wa_value_present_chk" CHECK \(\(([^;]*?)\)\);/)?.[1] ?? "";
    expect(chk).not.toBe("");
    for (const kind of ["boolean", "number", "text", "text_list", "json"]) {
      expect(chk, kind).toContain(`value_kind" = '${kind}'`);
    }
    // Five branches; each branch names its OWN column as IS NOT NULL and the other four as
    // IS NULL, so every column appears exactly four times in the exclusion form.
    for (const col of [
      "value_bool",
      "value_number",
      "value_text",
      "value_text_list",
      "value_json",
    ]) {
      const excluded = chk.split(`"${col}" IS NULL`).length - 1;
      expect(excluded, col).toBe(4);
    }
  });

  it("wa_value_kind_chk admits exactly the five kinds", () => {
    const chk = FLAT.match(/"wa_value_kind_chk" CHECK \(([^;]*?)\)/)?.[1] ?? "";
    for (const kind of ["boolean", "number", "text", "text_list", "json"]) {
      expect(chk, kind).toContain(`'${kind}'`);
    }
  });

  it("a json value must be an object, and only a json row may carry one", () => {
    const chk = FLAT.match(/"wa_value_json_shape_chk" CHECK \(([^;]*?)\);/)?.[1] ?? "";
    expect(chk).toContain("jsonb_typeof");
    expect(chk).toContain("'object'");
    expect(chk).toContain(`value_kind" = 'json'`);
  });
});
