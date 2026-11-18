/**
 * Migration `<slot>_payment_refunds` — admin refunds of real paid packs (#2750 item 10). The file
 * is found by its NAME, not its number: the slot is taken at merge time and may be regenerated
 * under another number, and this test must follow it without an edit.
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is the
 * half they do not see:
 *
 *   1. ADDITIVE — one new table, its indexes and foreign keys. Nothing dropped, no existing table
 *      altered beyond being referenced, no row written.
 *   2. THE RLS TAIL — FORCE and the four REVOKEs are hand-appended; a regenerate drops them.
 *   3. ONE REFUND PER ORDER, ONE ROW PER PROVIDER REFUND — the unique indexes the service relies
 *      on, and the CHECKs tying the status to the failure code, the provider id and the time.
 *   4. THE HEADER — deploy order (before refunds are turned on), the locks and the rollback.
 *
 * Nothing here connects to a database — it reads the committed SQL, journal and snapshot.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATIONS = join(__dirname, "..", "migrations");
const FILE = readdirSync(MIGRATIONS).filter((f) => /^\d{4}_payment_refunds\.sql$/.test(f));
const TAG = (FILE[0] ?? "").replace(/\.sql$/, "");
const SLOT = TAG.slice(0, 4);
const T = "payment_refunds";
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
  it("finds exactly one payment_refunds migration", () => {
    expect(FILE).toHaveLength(1);
  });

  it("reads a migration that creates the table", () => {
    expect(FLAT).toContain(`CREATE TABLE "${T}"`);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("APPLY BEFORE REFUNDS ARE TURNED ON");
    expect(DDL).not.toContain("APPLY BEFORE REFUNDS ARE TURNED ON");
  });
});

describe("the migration is additive", () => {
  it("creates exactly one table and three indexes", () => {
    expect([...FLAT.matchAll(/CREATE TABLE/g)]).toHaveLength(1);
    expect([...FLAT.matchAll(/CREATE (UNIQUE )?INDEX/g)]).toHaveLength(3);
  });

  it("alters only the new table", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(altered)).toEqual(new Set([T]));
  });

  it("drops nothing, deletes nothing, writes no rows and seeds nothing", () => {
    for (const verb of [
      "DROP TABLE",
      "DROP COLUMN",
      "DROP CONSTRAINT",
      "DROP INDEX",
      "TRUNCATE",
      "DELETE FROM",
      "INSERT INTO",
      'UPDATE "',
    ]) {
      expect(FLAT.toUpperCase()).not.toContain(verb);
    }
    expect(FLAT).not.toContain("__drizzle_migrations");
  });

  it("references only payment_orders (kept: a refund is a money record) and job_postings (set null)", () => {
    const refs = [
      ...FLAT.matchAll(/REFERENCES "public"\."([a-z_]+)"\("id"\) ON DELETE (\w+ ?\w*)/g),
    ];
    expect(refs.map((m) => `${m[1]}:${m[2]!.replace(/ ON$/, "")}`).sort()).toEqual([
      "job_postings:set null",
      "payment_orders:no action",
    ]);
  });
});

describe("deny by default", () => {
  it("enables AND forces RLS, and revokes every client role — no policy", () => {
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

describe("one refund per order, closed codes, a status that adds up", () => {
  it("one refund per order, one row per provider refund", () => {
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "payment_refunds_order_uq" ON "${T}" USING btree ("payment_order_id")`,
    );
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "payment_refunds_provider_uq" ON "${T}" USING btree ("provider_refund_id") WHERE "${T}"."provider_refund_id" IS NOT NULL`,
    );
  });

  it("closed rule and status codes; a positive amount; no negative credits", () => {
    expect(FLAT).toContain(`CHECK ("${T}"."rule" IN ('unused', 'low_match'))`);
    expect(FLAT).toContain(
      `CHECK ("${T}"."status" IN ('requested', 'pending', 'processed', 'failed'))`,
    );
    expect(FLAT).toContain(`CHECK ("${T}"."amount_paise" > 0)`);
    expect(FLAT).toContain(`CHECK ("${T}"."credits_removed" >= 0)`);
  });

  it("failed exactly when a failure code is set; processed exactly when a time is; a provider id once accepted", () => {
    expect(FLAT).toContain(`("${T}"."status" = 'failed') = ("${T}"."failure_code" IS NOT NULL)`);
    expect(FLAT).toContain(
      `("${T}"."status" = 'processed') = ("${T}"."processed_at" IS NOT NULL)`,
    );
    expect(FLAT).toContain(
      `("${T}"."status" NOT IN ('pending', 'processed') OR "${T}"."provider_refund_id" IS NOT NULL)`,
    );
    expect(FLAT).toContain(
      `("${T}"."rule" = 'low_match') = ("${T}"."applicants_counted" IS NOT NULL)`,
    );
  });

  it("no free text column", () => {
    expect(FLAT).not.toMatch(/"(note|notes|reason|comment)[a-z_]*" text/);
  });
});

describe("the header", () => {
  it("states the deploy order, the slot order, the locks and the rollback", () => {
    expect(RAW).toContain("credit notes");
    expect(RAW).toContain("Apply every lower-numbered migration first");
    expect(RAW).toContain("lock_timeout");
    expect(RAW).toContain(`DROP TABLE IF EXISTS "${T}";`);
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
