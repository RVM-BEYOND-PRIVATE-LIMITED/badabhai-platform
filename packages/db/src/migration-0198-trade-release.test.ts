/**
 * Migration `<slot>_trade_release` — the per-trade release switch (#3002). The file is found by
 * its NAME, not its number: the slot is taken at merge time and may be regenerated under another
 * number, and this test must follow it without an edit.
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is
 * the half they do not see:
 *
 *   1. ADDITIVE — one new table, no existing object altered. The ONLY rows written are the 16
 *      live posting kinds seeded `posting_enabled = true` (deploy-day behaviour is today's).
 *   2. THE RLS TAIL — FORCE and the four REVOKEs are hand-appended; a regenerate drops them.
 *   3. THE RULES THE READERS RELY ON — the key is the role kind under the 0196/0197 closed set
 *      (a kind outside it cannot be switched on), both flags default off, `updated_*` audit the
 *      change, and a kind with no row reads as off (the primary key admits no second row, and
 *      nothing else in the file can conjure a default-on).
 *   4. THE HEADER — deploy order (before the readers, not the deploy), the locks, the rollback.
 *
 * Nothing here connects to a database — it reads the committed SQL, journal and snapshot.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATIONS = join(__dirname, "..", "migrations");
const FILE = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_trade_release\.sql$/.test(f));
const TAG = (FILE[0] ?? "").replace(/\.sql$/, "");
const SLOT = TAG.slice(0, 4);
const T = "trade_release";
const RAW = readFileSync(join(MIGRATIONS, `${TAG}.sql`), "utf8");
/** Statements with comments stripped, so the header's prose cannot satisfy a DDL assertion. */
const DDL = RAW.replace(/--[^\n]*/g, " ");
const FLAT = DDL.replace(/\s+/g, " ");

const JOURNAL = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
  entries: { idx: number; when: number; tag: string }[];
};

const snapshot = (n: string): { id: string; prevId: string; tables: Record<string, unknown> } =>
  JSON.parse(readFileSync(join(MIGRATIONS, "meta", `${n}_snapshot.json`), "utf8"));

/** The 16 posting kinds live on deploy day (POSTING_TRADES, sheet order). */
const LIVE_16 = [
  "cnc_turner",
  "vmc_milling",
  "cnc_grinding",
  "cam_programmer",
  "cad_draughtsman",
  "conventional_machinist",
  "tool_die_maker",
  "welder",
  "sheet_metal_worker",
  "press_operator",
  "painter_coating",
  "fitter",
  "maintenance_technician",
  "industrial_electrician",
  "assembly_line_worker",
  "quality_inspector",
];

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("finds exactly one trade_release migration", () => {
    expect(FILE).toHaveLength(1);
  });

  it("reads a migration that creates the table", () => {
    expect(FLAT).toContain(`CREATE TABLE "${T}"`);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("BEFORE THE READERS, NOT BEFORE THE DEPLOY");
    expect(DDL).not.toContain("BEFORE THE READERS");
  });
});

describe("the migration is additive except for the 16-row seed", () => {
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

  it("seeds exactly the 16 live posting kinds, posting on and form off", () => {
    const inserts = [...FLAT.matchAll(/INSERT INTO "trade_release"[^;]*;/g)];
    expect(inserts).toHaveLength(1);
    const seed = inserts[0]![0];
    for (const kind of LIVE_16) {
      expect(seed).toContain(`('${kind}', true, false)`);
    }
    // No other kind is seeded: 16 tuples, each posting on.
    expect([...seed.matchAll(/\('[a-z][a-z0-9_]*', true, false\)/g)]).toHaveLength(16);
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

describe("the switch row", () => {
  it("the key is the role kind, under the 0196/0197 closed set", () => {
    expect(FLAT).toContain(`"role_kind" text PRIMARY KEY NOT NULL`);
    expect(FLAT).toContain(`CONSTRAINT "trade_release_role_kind_chk"`);
    for (const kind of [...LIVE_16, "gear_cutting_operator", "piping_designer"]) {
      expect(FLAT).toContain(`'${kind}'`);
    }
  });

  it("both flags default off, and every change names who and when", () => {
    expect(FLAT).toContain(`"posting_enabled" boolean DEFAULT false NOT NULL`);
    expect(FLAT).toContain(`"form_enabled" boolean DEFAULT false NOT NULL`);
    expect(FLAT).toContain(`"updated_by" text`);
    expect(FLAT).toContain(`"updated_at" timestamp with time zone DEFAULT now() NOT NULL`);
  });
});

describe("the header", () => {
  it("states the deploy order, the locks and the rollback", () => {
    expect(RAW).toContain("NOT BEFORE THE DEPLOY");
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
