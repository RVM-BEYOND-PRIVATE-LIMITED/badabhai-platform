/**
 * Migration 0128 — `worker_resume_skin`, the résumé skin a worker chose (#1801).
 *
 * The drizzle model and CI's drift check cover the table-vs-model half (a signal, not a merge gate —
 * that CI job does not block). What they do NOT see, and what this file pins, is the half that
 * lives in the hand-edits and the contract:
 *
 *   1. ADDITIVE — one new table. Nothing dropped, no existing table altered.
 *   2. THE RLS TAIL — FORCE and the four REVOKEs are hand-appended; a regenerate drops them.
 *   3. THE VOCABULARY — the CHECK is exactly `RESUME_SKINS`, so the DB cannot hold a skin the
 *      renderer, the DTO and the event do not know.
 *   4. THE HEADER — deploy order and rollback are written down.
 *
 * Nothing here connects to a database — it reads the committed SQL.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RESUME_SKINS } from "@badabhai/types";

const TAG = "0128_worker_resume_skin";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");

/** Statements with comments stripped, so the header's prose cannot satisfy a DDL assertion. */
const DDL = RAW.replace(/--[^\n]*/g, " ");
const FLAT = DDL.replace(/\s+/g, " ");

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("reads a migration that creates the table", () => {
    expect(FLAT).toContain('CREATE TABLE "worker_resume_skin"');
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("APPLY BEFORE THE FLAG");
    expect(DDL).not.toContain("APPLY BEFORE THE FLAG");
  });
});

describe("0128 is additive", () => {
  it("creates exactly one table", () => {
    expect([...FLAT.matchAll(/CREATE TABLE/g)]).toHaveLength(1);
  });

  it("alters only the new table", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)" ([^;]+);/g)].map(
      (m) => `${m[1]} ${m[2]}`,
    );
    expect(altered).toHaveLength(3); // ENABLE, the FK, FORCE
    for (const statement of altered) {
      expect(statement).toMatch(/^worker_resume_skin (ENABLE|FORCE|ADD CONSTRAINT)/);
    }
  });

  it("drops nothing, truncates nothing, deletes nothing, writes no rows", () => {
    for (const verb of [
      "DROP TABLE",
      "DROP COLUMN",
      "DROP CONSTRAINT",
      "TRUNCATE",
      "DELETE FROM",
      "INSERT INTO",
      'UPDATE "', // an UPDATE statement — not the FK's `ON UPDATE no action`
    ]) {
      expect(FLAT.toUpperCase()).not.toContain(verb);
    }
  });

  it("never touches the migration ledger", () => {
    expect(FLAT).not.toContain("__drizzle_migrations");
  });

  it("states the deploy order and the rollback in the header", () => {
    expect(RAW).toContain("RESUME_SKINS_ENABLED");
    expect(RAW).toContain('DROP TABLE "worker_resume_skin";');
  });
});

describe("the skin vocabulary", () => {
  it("the CHECK admits exactly RESUME_SKINS — no more, no fewer", () => {
    const check =
      /CONSTRAINT "wrs_skin_chk" CHECK \("worker_resume_skin"\."skin" IN \(([^)]*)\)\)/.exec(FLAT);
    expect(check).not.toBeNull();
    const inSql = check![1]!.split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
    expect(inSql).toEqual([...RESUME_SKINS]);
  });

  it("skin is NOT NULL — a row always names a skin; no row is the default", () => {
    expect(FLAT).toContain('"skin" text NOT NULL');
  });
});

describe("the table is locked (RLS tail is hand-appended)", () => {
  it("enables and FORCES row level security", () => {
    expect(FLAT).toContain('ALTER TABLE "worker_resume_skin" ENABLE ROW LEVEL SECURITY');
    expect(FLAT).toContain('ALTER TABLE "worker_resume_skin" FORCE ROW LEVEL SECURITY');
  });

  it.each(["PUBLIC", "anon", "authenticated", "service_role"])(
    "revokes everything from %s",
    (role) => {
      expect(FLAT).toContain(`REVOKE ALL ON TABLE "worker_resume_skin" FROM ${role}`);
    },
  );

  it("declares no policy — deny by default", () => {
    expect(FLAT.toUpperCase()).not.toContain("CREATE POLICY");
    expect(FLAT.toUpperCase()).not.toContain("GRANT ");
  });

  it("keys one row per worker and cascades on worker delete, so erasure needs no extra step", () => {
    expect(FLAT).toContain('"worker_id" uuid PRIMARY KEY NOT NULL');
    expect(FLAT).toMatch(
      /FOREIGN KEY \("worker_id"\) REFERENCES "public"\."workers"\("id"\) ON DELETE cascade/,
    );
  });
});

describe("the journal", () => {
  // Located by TAG, not `.at(-1)`, so a later migration cannot fail this file (the 0126 lesson).
  it("records 0128 at idx 128, with a `when` above its predecessor's", () => {
    const at = JOURNAL.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    const entry = JOURNAL.entries[at]!;
    const previous = JOURNAL.entries[at - 1]!;
    expect(entry.idx).toBe(128);
    expect(previous.tag).toBe("0127_reach_skill_ids_jsonb_ops_gin");
    expect(entry.when).toBeGreaterThan(previous.when);
  });
});
