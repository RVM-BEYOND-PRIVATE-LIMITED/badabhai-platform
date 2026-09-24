/**
 * Migration 0125 — résumé history (ADR-0043).
 *
 * Owner rulings 2026-09-24: every AI résumé generation is its own history entry, the worker sees
 * the newest three, each entry says which flow made it (form / chat / resume upload), and nothing
 * is ever deleted. This migration records the two facts a history entry needs (its source and its
 * trigger), the one index the history read and "the current résumé" both order by, and the two
 * profile facts the label and the chat-accepted regenerate are decided from.
 *
 * Pinned beyond the drift check: additive-only, every column nullable with no default, both CHECKs
 * tied to the ONE constant the event schema and the API share, the FK's delete action, the index's
 * sort order, the rollback and the slot. Nothing here connects to a database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { RESUME_GENERATION_TRIGGERS, RESUME_SOURCES } from "@badabhai/types";
import { describe, expect, it } from "vitest";

const TAG = "0125_resume_history";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");
const DDL = RAW.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const flat = (s: string): string => s.replace(/\s+/g, " ");
const FLAT = flat(DDL);

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

const quotedIn = (chk: string): string[] =>
  [...chk.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);

describe("the fixture is real", () => {
  it("reads a migration that adds all four columns", () => {
    expect(FLAT).toContain('ADD COLUMN "generation_source" text');
    expect(FLAT).toContain('ADD COLUMN "generation_trigger" text');
    expect(FLAT).toContain('ADD COLUMN "seeded_from_import_id" uuid');
    expect(FLAT).toContain('ADD COLUMN "resume_update_accepted_at" timestamp with time zone');
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    // The header lists the rollback, which names every column and constraint. Without this,
    // the assertions below would pass against the comment rather than the statements.
    expect(RAW).toContain("APPLY BEFORE DEPLOY");
    expect(DDL).not.toContain("APPLY BEFORE DEPLOY");
    expect(FLAT).not.toContain("DROP COLUMN");
  });
});

describe("0125 is additive", () => {
  it("touches only generated_resumes and worker_profiles, and drops or rewrites nothing", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1] as string);
    expect(new Set(altered)).toEqual(new Set(["generated_resumes", "worker_profiles"]));
    expect((FLAT.match(/ADD COLUMN/g) ?? []).length).toBe(4);
    // `UPDATE "` and `DELETE FROM`, not the bare verbs: the FK clause itself says
    // `ON DELETE set null ON UPDATE no action`, which is a referential action, not a data write.
    for (const verb of ["DROP ", "TRUNCATE", 'UPDATE "', "DELETE FROM"]) {
      expect(FLAT.toUpperCase()).not.toContain(verb);
    }
  });

  it("every new column is NULLABLE with no default — catalog-only, and no backfill", () => {
    // NO BACKFILL IS THE POINT. A default would make every résumé already on file claim a source
    // and a trigger nobody recorded, and a NOT NULL would rewrite the table to say it.
    for (const column of [
      "generation_source",
      "generation_trigger",
      "seeded_from_import_id",
      "resume_update_accepted_at",
    ]) {
      const line = FLAT.match(new RegExp(`ADD COLUMN "${column}"[^;]*`))?.[0] ?? "";
      expect(line, column).not.toBe("");
      expect(line, column).not.toContain("NOT NULL");
      expect(line, column).not.toContain("DEFAULT");
    }
  });

  it("tells the operator to apply under a lock timeout and to revert the deploy before rolling back", () => {
    expect(RAW).toContain("SET lock_timeout");
    expect(RAW).toContain("REVERT THE APP DEPLOY FIRST");
    expect(RAW).toContain("drizzle.__drizzle_migrations");
  });

  it("states the rollback and holds the only 0125 slot", () => {
    for (const statement of [
      'DROP CONSTRAINT "generated_resumes_generation_trigger_chk"',
      'DROP CONSTRAINT "generated_resumes_generation_source_chk"',
      'DROP INDEX "worker_profiles_seeded_from_import_idx"',
      'DROP INDEX "generated_resumes_worker_generated_idx"',
      'DROP COLUMN "resume_update_accepted_at"',
      'DROP COLUMN "seeded_from_import_id"',
      'DROP COLUMN "generation_trigger"',
      'DROP COLUMN "generation_source"',
    ]) {
      expect(RAW).toContain(statement);
    }
    const entry = JOURNAL.entries.find((e) => e.tag === TAG);
    expect(entry?.idx).toBe(125);
    const sorted = [...JOURNAL.entries].sort((a, b) => a.idx - b.idx);
    const at = sorted.findIndex((e) => e.tag === TAG);
    expect(sorted[at - 1]?.idx).toBe(124);
    // The skip watermark: drizzle ignores any entry whose `when` is at or below the newest one
    // it has recorded, so a `when` that does not strictly increase is silently never applied.
    expect(sorted[at]?.when).toBeGreaterThan(sorted[at - 1]!.when);
  });
});

describe("the vocabulary CHECKs", () => {
  const sourceChk = FLAT.match(/"generated_resumes_generation_source_chk" CHECK[^;]*/)?.[0] ?? "";
  const triggerChk = FLAT.match(/"generated_resumes_generation_trigger_chk" CHECK[^;]*/)?.[0] ?? "";

  it("are both present and NULL-tolerant — pre-0125 rows carry neither and must stay writable", () => {
    expect(sourceChk).not.toBe("");
    expect(triggerChk).not.toBe("");
    expect(sourceChk).toContain("IS NULL");
    expect(triggerChk).toContain("IS NULL");
  });

  it("close EXACTLY the shared constants", () => {
    // The same values are a `z.enum` on `resume.generated` / `resume.regenerated` and the union
    // the API writes. Copies that can drift is how an event the registry refuses gets emitted for
    // a row the database happily stored, so this pins the SQL to the constants.
    expect(new Set(quotedIn(sourceChk))).toEqual(new Set(RESUME_SOURCES));
    expect(new Set(quotedIn(triggerChk))).toEqual(new Set(RESUME_GENERATION_TRIGGERS));
  });
});

describe("the FK and the index", () => {
  it("links the import with ON DELETE SET NULL — losing the import costs the label, never the profile", () => {
    const fk = FLAT.match(/FOREIGN KEY \("seeded_from_import_id"\)[^;]*/)?.[0] ?? "";
    expect(fk).toContain('REFERENCES "public"."worker_resume_import"("id")');
    expect(fk).toContain("ON DELETE set null");
    expect(fk).not.toContain("cascade");
  });

  it("orders by generated_at then id, both DESC NULLS LAST — the pathkeys the reads spell out", () => {
    // `latestResume` / `listHistory` write `desc nulls last` explicitly because Postgres compares
    // nulls ordering STRICTLY when matching an index's pathkeys; a bare `desc` would sort instead
    // of walking this index. See `apps/api/src/profiles/ai-jobs.repository.ts` for the measurement.
    const index =
      FLAT.match(/CREATE INDEX "generated_resumes_worker_generated_idx"[^;]*/)?.[0] ?? "";
    expect(index).toContain('("worker_id","generated_at" DESC NULLS LAST,"id" DESC NULLS LAST)');
  });

  it("indexes the FK column, PARTIALLY — or every account deletion scans worker_profiles", () => {
    // The SET NULL runs per deleted import, and account deletion cascades imports. Without this
    // index each one seq-scans `worker_profiles` (measured ~99% of a 100-worker deletion).
    const index =
      FLAT.match(/CREATE INDEX "worker_profiles_seeded_from_import_idx"[^;]*/)?.[0] ?? "";
    expect(index).toContain('("seeded_from_import_id")');
    expect(index).toContain('"worker_profiles"."seeded_from_import_id" IS NOT NULL');
  });
});
