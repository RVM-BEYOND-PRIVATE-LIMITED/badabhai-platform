/**
 * Migration 0126 — tiered profiling: `question_pack_item.min_tier` + `worker_profiling_tier`.
 *
 * The drizzle model and CI's drift check already guarantee the columns exist and match. What they
 * do NOT see, and what this file pins, is the half that lives in the hand-edits:
 *
 *   1. ADDITIVE — one new nullable column and its CHECK on a shipped table, one new table. Nothing
 *      dropped, no existing column or constraint altered.
 *   2. THE RLS TAIL — FORCE and the four REVOKEs are hand-appended; a regenerate drops them.
 *   3. THE BACKFILL — every worker who had already profiled becomes `hard`/`backfill`, and a
 *      re-run is a no-op.
 *   4. IDEMPOTENT DDL — this was first authored as `0125_profiling_tiers`, and that tag was
 *      reported applied to production from an uncommitted tree. Every statement tolerates its
 *      object already existing, so applying 0126 there is a no-op rather than a failure.
 *
 * Nothing here connects to a database — it reads the committed SQL.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const TAG = "0126_profiling_tiers";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");

/** Statements with comments stripped, so the header's prose cannot satisfy a DDL assertion. */
const DDL = RAW.replace(/--[^\n]*/g, " ");
const FLAT = DDL.replace(/\s+/g, " ");

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("reads a migration that creates the table", () => {
    expect(FLAT).toContain('CREATE TABLE IF NOT EXISTS "worker_profiling_tier"');
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("APPLY BEFORE THE NEXT PACK SEED");
    expect(DDL).not.toContain("APPLY BEFORE THE NEXT PACK SEED");
  });
});

describe("0125 is additive", () => {
  it("alters only the new table and question_pack_item, and only by adding", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)" ([^;]+);/g)].map(
      (m) => `${m[1]} ${m[2]}`,
    );
    expect(altered.length).toBe(5); // ENABLE, FORCE, the FK, the column and its CHECK
    for (const statement of altered) {
      expect(statement).toMatch(
        /^(worker_profiling_tier (ENABLE|FORCE|ADD CONSTRAINT)|question_pack_item ADD (COLUMN|CONSTRAINT))/,
      );
    }
    expect(FLAT).toContain(
      'ALTER TABLE "question_pack_item" ADD COLUMN IF NOT EXISTS "min_tier" text;',
    );
  });

  it("adds min_tier NULLABLE with no default, so existing rows read as hard and nothing is rewritten", () => {
    expect(FLAT).not.toMatch(/"min_tier" text (NOT NULL|DEFAULT)/);
    expect(FLAT).toContain(
      `"min_tier" IS NULL OR "question_pack_item"."min_tier" IN ('easy', 'medium', 'hard')`,
    );
  });

  it("drops nothing and truncates nothing", () => {
    for (const verb of [
      "DROP TABLE",
      "DROP COLUMN",
      "DROP CONSTRAINT",
      "TRUNCATE",
      "DELETE FROM",
    ]) {
      expect(FLAT.toUpperCase()).not.toContain(verb);
    }
  });

  it("states the rollback in the header", () => {
    expect(RAW).toContain('DROP TABLE "worker_profiling_tier";');
    expect(RAW).toContain('ALTER TABLE "question_pack_item" DROP COLUMN "min_tier";');
  });
});

describe("every statement tolerates its object already existing", () => {
  it("creates the table and adds the column only if absent", () => {
    expect(FLAT).toContain('CREATE TABLE IF NOT EXISTS "worker_profiling_tier"');
    expect(FLAT).toContain('ADD COLUMN IF NOT EXISTS "min_tier"');
  });

  it("adds each constraint inside a block that swallows ONLY duplicate_object", () => {
    const blocks = [...FLAT.matchAll(/DO \$\$ BEGIN (.*?) END \$\$;/g)].map((m) => m[1] as string);
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block).toMatch(/^ALTER TABLE "[a-z_]+" ADD CONSTRAINT /);
      expect(block).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL;$/);
    }
    // No bare ADD CONSTRAINT outside a guard.
    expect(FLAT.replace(/DO \$\$ BEGIN .*? END \$\$;/g, "")).not.toContain("ADD CONSTRAINT");
  });

  it("never touches the migration ledger", () => {
    expect(FLAT).not.toContain("__drizzle_migrations");
  });
});

describe("the table is locked (RLS tail is hand-appended)", () => {
  it("enables and FORCES row level security", () => {
    expect(FLAT).toContain('ALTER TABLE "worker_profiling_tier" ENABLE ROW LEVEL SECURITY');
    expect(FLAT).toContain('ALTER TABLE "worker_profiling_tier" FORCE ROW LEVEL SECURITY');
  });

  it.each(["PUBLIC", "anon", "authenticated", "service_role"])(
    "revokes everything from %s",
    (role) => {
      expect(FLAT).toContain(`REVOKE ALL ON TABLE "worker_profiling_tier" FROM ${role}`);
    },
  );

  it("cascades on worker delete, so erasure needs no extra step", () => {
    expect(FLAT).toMatch(
      /FOREIGN KEY \("worker_id"\) REFERENCES "public"\."workers"\("id"\) ON DELETE cascade/,
    );
  });
});

describe("the backfill", () => {
  it("marks every already-profiled worker hard, as a backfill", () => {
    expect(FLAT).toContain(`SELECT w."id", 'hard', 'backfill' FROM "workers" AS w`);
    expect(FLAT).toContain('FROM "worker_profiles" AS p');
    expect(FLAT).toContain('FROM "worker_pack_answer" AS a');
  });

  it("is idempotent", () => {
    expect(FLAT).toContain('ON CONFLICT ("worker_id") DO NOTHING');
  });
});

describe("the journal", () => {
  // Located by TAG, not `.at(-1)`: "0126 is last" stopped being true the day 0127 landed, and a
  // positional pin fails every later migration PR for a reason that has nothing to do with 0126.
  it("records 0126 at idx 126, with a `when` above its predecessor's", () => {
    const at = JOURNAL.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    const entry = JOURNAL.entries[at]!;
    const previous = JOURNAL.entries[at - 1]!;
    expect(entry.idx).toBe(126);
    expect(entry.when).toBeGreaterThan(previous.when);
  });
});
