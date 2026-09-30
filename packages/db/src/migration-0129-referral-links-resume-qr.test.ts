/**
 * Migration 0129 — `referral_links_kind_chk` widened to admit 'resume_qr', plus the partial unique
 * index `referral_links_resume_qr_owner_uq` (#1800, owner ruling 2026-09-28 "Count + attribute
 * worker signups").
 *
 * The drizzle model and CI's drift check cover the table-vs-model half. What this file pins is the
 * half they do not see:
 *
 *   1. ADDITIVE — one CHECK re-added wider, one index created; no column, no row, no other table.
 *   2. THE VOCABULARY — the CHECK closes exactly `REFERRAL_LINK_KINDS`, and keeps every kind 0060
 *      allowed (so no stored row can fail the re-add).
 *   3. THE INDEX — unique, on `owner_worker_id`, partial on kind = 'resume_qr' AND owner NOT NULL.
 *      Its predicate is what the render's ON CONFLICT must repeat, and the NOT NULL half is what
 *      lets erasure (FK SET NULL) leave any number of dead rows.
 *   4. NO "resume_qr ⇒ owner NOT NULL" CHECK — it would abort the SET NULL, i.e. the erasure.
 *   5. THE HEADER — deploy order, locks and the pre-checked rollback are written down.
 *
 * Nothing here connects to a database — it reads the committed SQL, journal and snapshot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { REFERRAL_LINK_KINDS } from "@badabhai/types";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { referralLinks } from "./schema/referral";

const TAG = "0129_referral_links_resume_qr";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");
/** Statements with comments stripped, so the header's prose cannot satisfy a DDL assertion. */
const DDL = RAW.replace(/--[^\n]*/g, " ");
const FLAT = DDL.replace(/\s+/g, " ");

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

interface SnapshotTable {
  indexes: Record<string, { isUnique: boolean; where?: string; columns: { expression: string }[] }>;
  checkConstraints: Record<string, { value: string }>;
}
const snapshot = (
  n: string,
): { id: string; prevId: string; tables: Record<string, SnapshotTable> } =>
  JSON.parse(
    readFileSync(join(__dirname, "..", "migrations", "meta", `${n}_snapshot.json`), "utf8"),
  );

/** The three kinds 0060 allowed. Every one must survive, or a stored row fails the re-add. */
const KINDS_0060 = ["agent", "worker", "campaign"] as const;

const chk = FLAT.match(/ADD CONSTRAINT "referral_links_kind_chk" CHECK[^;]*/)?.[0] ?? "";
const listed = [...chk.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
const INDEX_PREDICATE = `"referral_links"."kind" = 'resume_qr' AND "referral_links"."owner_worker_id" IS NOT NULL`;

describe("the fixture is real (no assertion below is vacuous)", () => {
  it("reads a migration that re-adds the kind CHECK and creates the index", () => {
    expect(FLAT).toContain('DROP CONSTRAINT "referral_links_kind_chk"');
    expect(FLAT).toContain('ADD CONSTRAINT "referral_links_kind_chk"');
    expect(FLAT).toContain('CREATE UNIQUE INDEX "referral_links_resume_qr_owner_uq"');
    expect(listed.length).toBeGreaterThan(0);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    // The header's ROLLBACK block spells out the old three-kind CHECK.
    expect(RAW).toContain("APPLY BEFORE THE FLAG");
    expect(DDL).not.toContain("APPLY BEFORE THE FLAG");
  });
});

describe("0129 is additive", () => {
  it("alters only referral_links, and drops only the CHECK it re-adds", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1] as string);
    expect([...new Set(altered)]).toEqual(["referral_links"]);
    const dropped = [...FLAT.matchAll(/DROP CONSTRAINT "([a-z_]+)"/g)].map((m) => m[1]);
    expect(dropped).toEqual(["referral_links_kind_chk"]);
    const created = [...FLAT.matchAll(/CREATE (?:UNIQUE )?INDEX "([a-z_]+)"/g)].map((m) => m[1]);
    expect(created).toEqual(["referral_links_resume_qr_owner_uq"]);
  });

  it("drops no column or table, writes no rows, and never touches the ledger", () => {
    for (const verb of [
      "DROP TABLE",
      "DROP COLUMN",
      "DROP INDEX",
      "ADD COLUMN",
      "TRUNCATE",
      "DELETE FROM",
      "INSERT INTO",
      'UPDATE "',
    ]) {
      expect(FLAT.toUpperCase()).not.toContain(verb);
    }
    expect(FLAT).not.toContain("__drizzle_migrations");
  });

  it("re-adds the CHECK BEFORE creating the index, so the two statements that swap the CHECK sit together", () => {
    const drop = FLAT.indexOf('DROP CONSTRAINT "referral_links_kind_chk"');
    const add = FLAT.indexOf('ADD CONSTRAINT "referral_links_kind_chk"');
    const index = FLAT.indexOf('CREATE UNIQUE INDEX "referral_links_resume_qr_owner_uq"');
    expect(drop).toBeLessThan(add);
    expect(add).toBeLessThan(index);
  });
});

describe("the widened CHECK", () => {
  it("closes EXACTLY the four kinds declared when it was written — a FROZEN record", () => {
    // A migration file never changes, so this pins it to a literal; the LIVE agreement with the
    // shared constant is the schema test below.
    expect([...listed].sort()).toEqual(["agent", "campaign", "resume_qr", "worker"]);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("keeps every kind 0060 allowed, so no stored row can fail the re-add", () => {
    for (const kind of KINDS_0060) expect(listed).toContain(kind);
  });

  it("adds NO 'resume_qr ⇒ owner NOT NULL' rule — that would abort the erasure's SET NULL", () => {
    expect(chk).not.toMatch(/owner_worker_id/);
    expect([...FLAT.matchAll(/ADD CONSTRAINT/g)]).toHaveLength(1);
  });
});

describe("the one-link-per-worker index", () => {
  it("is UNIQUE on owner_worker_id, partial on kind = 'resume_qr' AND the owner being set", () => {
    expect(FLAT).toContain(
      `CREATE UNIQUE INDEX "referral_links_resume_qr_owner_uq" ON "referral_links" USING btree ("owner_worker_id") WHERE ${INDEX_PREDICATE}`,
    );
  });

  it("is not CONCURRENTLY — drizzle applies each file inside one transaction", () => {
    expect(FLAT.toUpperCase()).not.toContain("CONCURRENTLY");
  });
});

describe("the LIVE model and the snapshot agree with the migration", () => {
  const dialect = new PgDialect();
  const config = getTableConfig(referralLinks);

  it("the model's kind CHECK closes exactly REFERRAL_LINK_KINDS", () => {
    // THE TRIPWIRE THAT OUTLIVES THIS MIGRATION: a fifth kind added to the shared constant turns
    // this red until the CHECK (and so a new migration) follows.
    const check = config.checks.find((c) => c.name === "referral_links_kind_chk");
    if (!check) throw new Error("referral_links_kind_chk is not on the model");
    const kinds = [...dialect.sqlToQuery(check.value).sql.matchAll(/'([a-z_]+)'/g)].map(
      (m) => m[1],
    );
    expect(kinds.sort()).toEqual([...REFERRAL_LINK_KINDS].sort());
  });

  it("the model carries the partial unique index", () => {
    const index = config.indexes.find((i) => i.config.name === "referral_links_resume_qr_owner_uq");
    expect(index?.config.unique).toBe(true);
  });

  it("0129's snapshot builds on 0128's and records both objects", () => {
    const prev = snapshot("0128");
    const next = snapshot("0129");
    expect(next.prevId).toBe(prev.id);
    const table = next.tables["public.referral_links"]!;
    expect(table.checkConstraints["referral_links_kind_chk"]!.value).toContain("'resume_qr'");
    const index = table.indexes["referral_links_resume_qr_owner_uq"]!;
    expect(index.isUnique).toBe(true);
    expect(index.where).toBe(INDEX_PREDICATE);
    expect(index.columns.map((c) => c.expression)).toEqual(["owner_worker_id"]);
  });
});

describe("the header", () => {
  it("states the flag, the lock_timeout and a PRE-CHECKED rollback", () => {
    expect(RAW).toContain("RESUME_QR_SCAN_ENABLED");
    expect(RAW).toContain("SET LOCAL lock_timeout");
    expect(RAW).toContain(`SELECT count(*) FROM "referral_links" WHERE "kind" = 'resume_qr';`);
    expect(RAW).toContain('DROP INDEX "referral_links_resume_qr_owner_uq";');
    expect(RAW).toContain("CHECK (\"referral_links\".\"kind\" IN ('agent', 'worker', 'campaign'))");
  });
});

describe("the journal", () => {
  // Located by TAG, not `.at(-1)`, so a later migration cannot fail this file (the 0126 lesson).
  it("records 0129 at idx 129, after 0128, with a `when` above its predecessor's", () => {
    const at = JOURNAL.entries.findIndex((e) => e.tag === TAG);
    expect(at).toBeGreaterThan(0);
    const entry = JOURNAL.entries[at]!;
    const previous = JOURNAL.entries[at - 1]!;
    expect(entry.idx).toBe(129);
    expect(previous.tag).toBe("0128_worker_resume_skin");
    expect(entry.when).toBeGreaterThan(previous.when);
  });
});
