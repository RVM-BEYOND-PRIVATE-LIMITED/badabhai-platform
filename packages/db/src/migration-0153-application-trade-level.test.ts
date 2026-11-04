/**
 * Migration 0153 — `applications.trade_level` + `applications.level_confirmed` (engine v1.1
 * "Level needed", CEO ruling 30 Oct 2026, ADR-0061).
 *
 * The worker's rung, frozen onto his application. Pinned beyond the drift check: additive-only
 * (two nullable columns with no default, nothing dropped or rewritten, no backfill), the model
 * agreeing with the DDL, the APPLY-BEFORE-DEPLOY instruction + schema-contract registration, the
 * rollback, and the slot. Nothing here connects to a database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { SCHEMA_REQUIREMENTS } from "./schema-contract";
import { applications } from "./schema/job";

const TAG = "0153_application_trade_level";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");
const DDL = RAW.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const FLAT = DDL.replace(/\s+/g, " ");

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

describe("0153 is additive", () => {
  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain('DROP COLUMN "trade_level"');
    expect(DDL).not.toContain("DROP COLUMN");
  });

  it("is exactly two ADD COLUMNs on applications — and nothing else", () => {
    const statements = FLAT.split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements).toEqual([
      'ALTER TABLE "applications" ADD COLUMN "trade_level" text',
      'ALTER TABLE "applications" ADD COLUMN "level_confirmed" boolean',
    ]);
  });

  it("drops, rewrites and backfills nothing", () => {
    const upper = FLAT.toUpperCase();
    for (const verb of [
      "DROP ",
      "UPDATE ",
      "INSERT ",
      "DELETE ",
      "TRUNCATE",
      "RENAME",
      "ALTER COLUMN",
      "INDEX",
    ]) {
      expect(upper, verb).not.toContain(verb);
    }
    expect(upper).not.toContain("NOT NULL");
    expect(upper).not.toContain("DEFAULT");
  });
});

describe("the model agrees with the DDL", () => {
  it("applications.trade_level is a nullable text with no default", () => {
    const col = getTableConfig(applications).columns.find((c) => c.name === "trade_level");
    expect(col).toBeDefined();
    expect(col!.getSQLType()).toBe("text");
    expect(col!.notNull).toBe(false);
    expect(col!.hasDefault).toBe(false);
  });

  it("applications.level_confirmed is a nullable boolean with no default", () => {
    const col = getTableConfig(applications).columns.find((c) => c.name === "level_confirmed");
    expect(col).toBeDefined();
    expect(col!.getSQLType()).toBe("boolean");
    expect(col!.notNull).toBe(false);
    expect(col!.hasDefault).toBe(false);
  });

  it("leaves the rank index alone — the level group is computed, never indexed", () => {
    const idx = getTableConfig(applications).indexes.find(
      (i) => i.config.name === "applications_rank_idx",
    );
    expect(idx).toBeDefined();
    const names = idx!.config.columns.map((c) => ("name" in c ? c.name : ""));
    expect(names).not.toContain("trade_level");
    expect(names).not.toContain("level_confirmed");
  });
});

describe("the operator instructions and the slot", () => {
  it("says APPLY-BEFORE-DEPLOY, names the writer, and is registered in schema-contract", () => {
    expect(RAW).toContain("APPLY-BEFORE-DEPLOY");
    expect(RAW).toContain("apply upsert");
    expect(RAW).toContain("0153-applications-trade-level");
    const req = SCHEMA_REQUIREMENTS.find((r) => r.id === "0153-applications-trade-level");
    expect(req).toMatchObject({
      migration: TAG,
      kind: "column",
      table: "applications",
      object: "trade_level",
    });
  });

  it("states the lock guidance and the rollback", () => {
    expect(RAW).toContain("lock_timeout = '3s'");
    expect(RAW).toContain("55P03");
    expect(RAW).toContain("ROLLBACK");
    expect(RAW).toContain('ALTER TABLE "applications" DROP COLUMN "level_confirmed"');
    expect(RAW).toContain('ALTER TABLE "applications" DROP COLUMN "trade_level"');
  });

  it("holds the only 0153 slot, after 0152, with a later `when`", () => {
    const entry = JOURNAL.entries.find((e) => e.tag === TAG);
    expect(entry?.idx).toBe(153);
    expect(JOURNAL.entries.filter((e) => e.idx === 153)).toHaveLength(1);
    const sorted = [...JOURNAL.entries].sort((a, b) => a.idx - b.idx);
    const at = sorted.findIndex((e) => e.tag === TAG);
    expect(sorted[at - 1]?.idx).toBe(152);
    expect(sorted[at]!.when).toBeGreaterThan(sorted[at - 1]!.when);
  });
});
