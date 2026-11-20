/**
 * Migration `<slot>_campus_drive_request_erasures` — the erasure signal Campus reads for a deleted
 * campus-drive request, and the company delete it makes safe to let work (#2811, owners' gate).
 * The file is found by its NAME, not its number: the slot is taken at merge time and may be
 * regenerated under another number, and this test must follow it without an edit.
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is the
 * half they do not see:
 *
 *   1. THE ORDER — the table and its trigger come BEFORE the four foreign keys, in one file, so a
 *      company delete can never start working without the tombstone (no switch exists).
 *   2. THE TABLE — faceless (`request_id` and `erased_at`, nothing else), no foreign key, the feed's
 *      keyset index, RLS forced and the four REVOKEs.
 *   3. THE TRIGGER — AFTER DELETE FOR EACH ROW on `campus_drive_requests`, writing OLD.id only, ON
 *      CONFLICT DO NOTHING; SECURITY DEFINER with a pinned search_path and EXECUTE revoked.
 *   4. THE FOREIGN KEYS — exactly the four NO ACTION keys to `payers` become ON DELETE CASCADE,
 *      same names, NOT VALID then VALIDATE; nothing else is dropped.
 *   5. THE HEADER — no switch, deploy order, locks and rollback.
 *
 * Nothing here connects to a database — it reads the committed SQL, journal and snapshot.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATIONS = join(__dirname, "..", "migrations");
const FILE = readdirSync(MIGRATIONS).filter((f) =>
  /^\d{4}_campus_drive_request_erasures\.sql$/.test(f),
);
const TAG = (FILE[0] ?? "").replace(/\.sql$/, "");
const SLOT = TAG.slice(0, 4);
const TABLE = "campus_drive_request_erasures";
const FUNCTION = "public.campus_drive_request_erasure_record()";
const TRIGGER = "campus_drive_requests_erasure_trg";
const FKS = [
  ["employer_profiles", "employer_profiles_payer_id_fkey"],
  ["agency_profiles", "agency_profiles_payer_id_fkey"],
  ["payer_capabilities", "payer_capabilities_payer_id_fkey"],
  ["payer_member_invites", "payer_member_invites_payer_id_fkey"],
] as const;
const RAW = readFileSync(join(MIGRATIONS, `${TAG}.sql`), "utf8");
/** Statements with comments stripped, so the header's prose cannot satisfy a DDL assertion. */
const DDL = RAW.replace(/--[^\n]*/g, " ");
const FLAT = DDL.replace(/\s+/g, " ");
const UPPER = FLAT.toUpperCase();

const JOURNAL = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
  entries: { idx: number; when: number; tag: string }[];
};

type SnapshotTable = {
  columns: Record<string, unknown>;
  foreignKeys: Record<string, { onDelete?: string; tableTo?: string }>;
};
const snapshot = (n: string): { id: string; prevId: string; tables: Record<string, SnapshotTable> } =>
  JSON.parse(readFileSync(join(MIGRATIONS, "meta", `${n}_snapshot.json`), "utf8"));

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("finds exactly one campus_drive_request_erasures migration", () => {
    expect(FILE).toHaveLength(1);
  });

  it("reads a migration that creates the table", () => {
    expect(FLAT).toContain(`CREATE TABLE "${TABLE}"`);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("NO SWITCH");
    expect(DDL).not.toContain("NO SWITCH");
  });
});

describe("the order: the tombstone exists before the delete can work", () => {
  it("creates the table, then the trigger, then swaps the four foreign keys, last", () => {
    const table = FLAT.indexOf(`CREATE TABLE "${TABLE}"`);
    const trigger = FLAT.indexOf(`CREATE TRIGGER "${TRIGGER}"`);
    const firstFk = Math.min(...FKS.map(([t]) => FLAT.indexOf(`ALTER TABLE "${t}" DROP CONSTRAINT`)));
    expect(table).toBeGreaterThanOrEqual(0);
    expect(trigger).toBeGreaterThan(table);
    expect(firstFk).toBeGreaterThan(trigger);
  });
});

describe("the table: faceless, keyed by the request id, deny by default", () => {
  it("has exactly two columns: the request id (the key) and the time", () => {
    const body = /CREATE TABLE "campus_drive_request_erasures" \(([^;]*?)\);/.exec(FLAT)?.[1] ?? "";
    expect(body.trim()).toBe(
      `"request_id" uuid PRIMARY KEY NOT NULL, "erased_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL`,
    );
  });

  it("has no foreign key (the request row is gone) and the feed's keyset index", () => {
    expect(FLAT).not.toMatch(/ALTER TABLE "campus_drive_request_erasures" ADD CONSTRAINT/);
    expect(FLAT).toContain(
      `CREATE INDEX "campus_drive_request_erasures_feed_idx" ON "${TABLE}" USING btree ("erased_at","request_id")`,
    );
    expect([...FLAT.matchAll(/CREATE (UNIQUE )?INDEX/g)]).toHaveLength(1);
    expect([...FLAT.matchAll(/CREATE TABLE/g)]).toHaveLength(1);
  });

  it("enables AND forces RLS, and revokes every client role — no policy, no grant", () => {
    expect(FLAT).toContain(`ALTER TABLE "${TABLE}" ENABLE ROW LEVEL SECURITY`);
    expect(FLAT).toContain(`ALTER TABLE "${TABLE}" FORCE ROW LEVEL SECURITY`);
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      expect(FLAT).toContain(`REVOKE ALL ON TABLE "${TABLE}" FROM ${role}`);
    }
    expect(UPPER).not.toContain("CREATE POLICY");
    expect(UPPER).not.toContain("GRANT ");
  });
});

describe("the trigger: every delete leaves one tombstone, in the deleting transaction", () => {
  it("fires AFTER DELETE, FOR EACH ROW, on campus_drive_requests", () => {
    expect(FLAT).toContain(
      `CREATE TRIGGER "${TRIGGER}" AFTER DELETE ON public.campus_drive_requests FOR EACH ROW EXECUTE FUNCTION ${FUNCTION};`,
    );
    expect([...FLAT.matchAll(/CREATE TRIGGER/g)]).toHaveLength(1);
  });

  it("writes the deleted row's id and the statement's clock only, and never fails on a repeat", () => {
    const body = /AS \$function\$(.*?)\$function\$/.exec(FLAT)?.[1] ?? "";
    expect(body).toContain(
      "insert into public.campus_drive_request_erasures (request_id, erased_at) values (old.id, clock_timestamp()) on conflict (request_id) do nothing;",
    );
    expect(body).toContain("return old;");
    // Nothing else of OLD: no company, no contact, no other column.
    expect([...body.matchAll(/\bold\.(\w+)/g)].map((m) => m[1])).toEqual(["id"]);
  });

  it("is SECURITY DEFINER with a pinned search_path, and EXECUTE is revoked from every client role", () => {
    expect(FLAT).toContain(
      `CREATE FUNCTION ${FUNCTION} RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS`,
    );
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      expect(FLAT).toContain(`REVOKE ALL ON FUNCTION ${FUNCTION} FROM ${role}`);
    }
  });
});

describe("the four foreign keys: NO ACTION to ON DELETE CASCADE, same names", () => {
  it.each(FKS)("%s: drop, add NOT VALID with ON DELETE cascade, validate", (table, name) => {
    expect(FLAT).toContain(`ALTER TABLE "${table}" DROP CONSTRAINT "${name}";`);
    expect(FLAT).toContain(
      `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" FOREIGN KEY ("payer_id") REFERENCES "public"."payers"("id") ON DELETE cascade ON UPDATE no action NOT VALID;`,
    );
    expect(FLAT).toContain(`ALTER TABLE "${table}" VALIDATE CONSTRAINT "${name}";`);
    const drop = FLAT.indexOf(`DROP CONSTRAINT "${name}"`);
    const add = FLAT.indexOf(`ADD CONSTRAINT "${name}"`);
    const validate = FLAT.indexOf(`VALIDATE CONSTRAINT "${name}"`);
    expect(drop).toBeLessThan(add);
    expect(add).toBeLessThan(validate);
  });

  it("drops nothing else, deletes no row and writes none", () => {
    expect([...FLAT.matchAll(/DROP CONSTRAINT/g)]).toHaveLength(FKS.length);
    for (const verb of ["DROP TABLE", "DROP COLUMN", "DROP INDEX", "DROP TRIGGER", "DROP FUNCTION", "TRUNCATE", "DELETE FROM", 'UPDATE "', "ADD COLUMN"]) {
      expect(UPPER).not.toContain(verb);
    }
    // The only INSERT is the trigger's, inside the function body.
    expect([...UPPER.matchAll(/INSERT INTO/g)]).toHaveLength(1);
    expect(FLAT).not.toContain("__drizzle_migrations");
  });

  it("the snapshot records each of the four as cascading", () => {
    const tables = snapshot(SLOT).tables;
    for (const [table, name] of FKS) {
      const fk = tables[`public.${table}`]?.foreignKeys[name];
      expect(fk?.tableTo, name).toBe("payers");
      expect(fk?.onDelete, name).toBe("cascade");
    }
  });
});

describe("the header", () => {
  it("states no switch, the deploy order, the locks and the rollback", () => {
    expect(RAW).toContain("NO SWITCH");
    expect(RAW).toContain("DEPLOY ORDER - SAFE EITHER WAY");
    expect(RAW).toContain("42P01");
    expect(RAW).toContain("Apply every lower-numbered migration");
    expect(RAW).toContain("lock_timeout");
    expect(RAW).toContain(`DROP TRIGGER "${TRIGGER}" ON "campus_drive_requests";`);
    expect(RAW).toContain(`DROP TABLE "${TABLE}";`);
    // The rollback restores the foreign keys FIRST, so a delete never works without the trigger.
    expect(RAW.indexOf("ON DELETE no action ON UPDATE no action")).toBeLessThan(
      RAW.indexOf(`DROP TRIGGER "${TRIGGER}"`),
    );
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

  it("its snapshot builds on its predecessor's and records the table, its two columns only", () => {
    const previousSlot = String(Number(SLOT) - 1).padStart(4, "0");
    const next = snapshot(SLOT);
    expect(next.prevId).toBe(snapshot(previousSlot).id);
    expect(next.tables).toHaveProperty(`public.${TABLE}`);
    expect(Object.keys(next.tables[`public.${TABLE}`]!.columns).sort()).toEqual([
      "erased_at",
      "request_id",
    ]);
    expect(next.tables[`public.${TABLE}`]!.foreignKeys).toEqual({});
  });
});
