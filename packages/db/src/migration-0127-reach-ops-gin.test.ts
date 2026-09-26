/**
 * Migration 0127 — a `jsonb_ops` GIN on `job_postings.reach_skill_ids` (TD141).
 *
 * `job_postings_reach_gin` is `jsonb_path_ops`, which indexes only `@>`, `@?` and `@@`, so the
 * `reach_skill_ids ?| $skills` overlap (reach reconciliation, the #1240 search fallback, the
 * ADR-0044 companion) was never an index probe. The fix is a SECOND GIN with the default opclass.
 *
 * What this file pins, because drizzle's drift check cannot:
 *   1. the new index uses the DEFAULT opclass — a `jsonb_path_ops` here would reproduce TD141
 *      with a green check;
 *   2. ADDITIVE — the path_ops index is not dropped (it still serves `@>`), nothing else changes;
 *   3. IDEMPOTENT — `IF NOT EXISTS`, so a hand-applied copy cannot break a later `db:migrate`;
 *   4. the journal watermark — 0127's `when` is above 0126's, or drizzle would skip it forever.
 *
 * Nothing here connects to a database — it reads the committed SQL, schema and journal.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const TAG = "0127_reach_skill_ids_jsonb_ops_gin";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");

/** Statements with comments stripped, so the header's prose cannot satisfy a DDL assertion. */
const DDL = RAW.replace(/--[^\n]*/g, " ");
const FLAT = DDL.replace(/\s+/g, " ").trim();

const SCHEMA = readFileSync(join(__dirname, "schema", "job.ts"), "utf8");

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("jsonb_path_ops");
    expect(DDL).not.toContain("jsonb_path_ops");
  });
});

describe("0127 creates the index TD141 needs", () => {
  it("is exactly one idempotent CREATE INDEX with the default opclass", () => {
    expect(FLAT).toBe(
      'CREATE INDEX IF NOT EXISTS "job_postings_reach_ops_gin" ON "job_postings" USING gin ("reach_skill_ids");',
    );
  });

  it("is additive: drops nothing and alters nothing", () => {
    expect(FLAT).not.toMatch(/\bDROP\b/i);
    expect(FLAT).not.toMatch(/\bALTER\b/i);
  });

  it("is declared in the drizzle schema beside the path_ops index, which stays", () => {
    expect(SCHEMA).toContain('index("job_postings_reach_ops_gin").using("gin", t.reachSkillIds)');
    expect(SCHEMA).toContain(
      'index("job_postings_reach_gin").using("gin", t.reachSkillIds.op("jsonb_path_ops"))',
    );
  });
});

describe("the journal", () => {
  it("records 0127 at idx 127, with a `when` above 0126's", () => {
    const at = JOURNAL.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    const entry = JOURNAL.entries[at]!;
    const previous = JOURNAL.entries[at - 1]!;
    expect(entry.idx).toBe(127);
    expect(previous.tag).toBe("0126_profiling_tiers");
    expect(entry.when).toBeGreaterThan(previous.when);
  });
});
