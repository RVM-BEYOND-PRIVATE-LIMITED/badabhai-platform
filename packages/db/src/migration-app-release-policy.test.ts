/**
 * Migration `<slot>_app_release_policy` — the minimum supported app build (#3048). The file is
 * found by its NAME, not its number: the slot is taken at merge time and may be regenerated under
 * another number, and this test must follow it without an edit.
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is
 * the half they do not see:
 *
 *   1. ADDITIVE — one new table, no existing object altered. The ONLY rows written are the four
 *      app × platform rows at minimum 0 (deploy-day behaviour is today's: nothing gets a 426).
 *   2. THE RLS TAIL — FORCE and the four REVOKEs are hand-appended; a regenerate drops them.
 *   3. THE RULES THE GUARD AND THE APPS RELY ON — the key is (app, platform) under closed sets,
 *      builds are non-negative with latest >= minimum, the store link is https, every change
 *      names who and when.
 *   4. THE HEADER — deploy order, the locks, the rollback.
 *
 * Nothing here connects to a database — it reads the committed SQL, journal and snapshot.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATIONS = join(__dirname, "..", "migrations");
const FILE = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_app_release_policy\.sql$/.test(f));
const TAG = (FILE[0] ?? "").replace(/\.sql$/, "");
const SLOT = TAG.slice(0, 4);
const T = "app_release_policy";
const RAW = readFileSync(join(MIGRATIONS, `${TAG}.sql`), "utf8");
/** Statements with comments stripped, so the header's prose cannot satisfy a DDL assertion. */
const DDL = RAW.replace(/--[^\n]*/g, " ");
const FLAT = DDL.replace(/\s+/g, " ");

const JOURNAL = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
  entries: { idx: number; when: number; tag: string }[];
};

const snapshot = (n: string): { id: string; prevId: string; tables: Record<string, unknown> } =>
  JSON.parse(readFileSync(join(MIGRATIONS, "meta", `${n}_snapshot.json`), "utf8"));

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("finds exactly one app_release_policy migration", () => {
    expect(FILE).toHaveLength(1);
  });

  it("reads a migration that creates the table", () => {
    expect(FLAT).toContain(`CREATE TABLE "${T}"`);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("EITHER ORDER IS SAFE");
    expect(DDL).not.toContain("EITHER ORDER IS SAFE");
  });
});

describe("the migration is additive except for the four-row seed", () => {
  it("creates exactly one table and no index beyond its primary key", () => {
    expect([...FLAT.matchAll(/CREATE TABLE/g)]).toHaveLength(1);
    expect([...FLAT.matchAll(/CREATE (UNIQUE )?INDEX/g)]).toHaveLength(0);
  });

  it("alters only the new table", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set([T]));
  });

  it("drops nothing, deletes nothing and backfills nothing", () => {
    for (const verb of [
      "DROP TABLE",
      "DROP COLUMN",
      "DROP CONSTRAINT",
      "DROP INDEX",
      "TRUNCATE",
      "DELETE FROM",
      'UPDATE "',
    ]) {
      expect(FLAT.toUpperCase()).not.toContain(verb);
    }
    expect(FLAT).not.toContain("__drizzle_migrations");
  });

  it("seeds exactly the four app × platform rows, every minimum and latest at 0", () => {
    const inserts = [...FLAT.matchAll(/INSERT INTO "app_release_policy"[^;]*;/g)];
    expect(inserts).toHaveLength(1);
    const seed = inserts[0]![0];
    for (const app of ["worker", "payer"]) {
      for (const platform of ["android", "ios"]) {
        expect(seed).toContain(`('${app}', '${platform}', 0, 0)`);
      }
    }
    expect([...seed.matchAll(/\('[a-z]+', '[a-z]+', 0, 0\)/g)]).toHaveLength(4);
    // Nothing but zeros: no tuple carries another number.
    expect([...seed.matchAll(/\('[a-z]+', '[a-z]+', \d+, \d+\)/g)]).toHaveLength(4);
  });
});

describe("deny by default", () => {
  it("enables AND forces RLS, and revokes every client role", () => {
    expect(FLAT).toContain(`ALTER TABLE "${T}" ENABLE ROW LEVEL SECURITY`);
    expect(FLAT).toContain(`ALTER TABLE "${T}" FORCE ROW LEVEL SECURITY`);
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      expect(FLAT).toContain(`REVOKE ALL ON TABLE "${T}" FROM ${role}`);
    }
  });

  it("creates no policy and grants nothing", () => {
    expect(FLAT.toUpperCase()).not.toContain("CREATE POLICY");
    expect(FLAT.toUpperCase()).not.toContain("GRANT ");
  });
});

describe("the policy row", () => {
  it("the key is (app, platform), each under a closed set", () => {
    expect(FLAT).toContain(`CONSTRAINT "app_release_policy_pk" PRIMARY KEY("app","platform")`);
    expect(FLAT).toContain(`"app_release_policy"."app" IN ('worker', 'payer')`);
    expect(FLAT).toContain(`"app_release_policy"."platform" IN ('android', 'ios')`);
  });

  it("builds default to 0, are never negative, and latest is never below the minimum", () => {
    expect(FLAT).toContain(`"min_supported_build" integer DEFAULT 0 NOT NULL`);
    expect(FLAT).toContain(`"latest_build" integer DEFAULT 0 NOT NULL`);
    expect(FLAT).toContain(
      `"app_release_policy"."min_supported_build" >= 0 AND "app_release_policy"."latest_build" >= "app_release_policy"."min_supported_build"`,
    );
  });

  it("the store link is null or https; the copy key is a slug with a default", () => {
    expect(FLAT).toContain(`"store_url" text,`);
    expect(FLAT).toContain(`"app_release_policy"."store_url" ~ '^https://'`);
    expect(FLAT).toContain(`"message_key" text DEFAULT 'update_default' NOT NULL`);
  });

  it("every change names who and when", () => {
    expect(FLAT).toContain(`"updated_by" text`);
    expect(FLAT).toContain(`"updated_at" timestamp with time zone DEFAULT now() NOT NULL`);
  });
});

describe("the header", () => {
  it("states the deploy order, the locks and the rollback", () => {
    expect(RAW).toContain("EITHER ORDER IS SAFE");
    expect(RAW).toContain("lock_timeout");
    expect(RAW).toContain(`DROP TABLE "${T}";`);
  });
});

describe("the journal and the snapshot", () => {
  // Located by TAG, not `.at(-1)`, so a later migration cannot fail this file (the 0126 lesson).
  it("records the migration at its slot, after its predecessor, with a later `when`", () => {
    const at = JOURNAL.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    const entry = JOURNAL.entries[at]!;
    const previous = JOURNAL.entries[at - 1]!;
    expect(entry.idx).toBe(Number(SLOT));
    expect(previous.idx).toBe(Number(SLOT) - 1);
    expect(entry.when).toBeGreaterThan(previous.when);
  });

  it("its snapshot builds on its predecessor's and records the table", () => {
    const previousSlot = String(Number(SLOT) - 1).padStart(4, "0");
    const next = snapshot(SLOT);
    expect(next.prevId).toBe(snapshot(previousSlot).id);
    expect(next.tables).toHaveProperty(`public.${T}`);
  });
});
