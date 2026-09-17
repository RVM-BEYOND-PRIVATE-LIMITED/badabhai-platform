/**
 * Migration 0113 — `worker_portfolio` (Layer A (e)).
 *
 * Pinned beyond the drift check: additive-only, the content invariant (photo/video ⇒ storage_key,
 * link ⇒ url, never both), the http(s) scheme bound, the RLS tail, the rollback and the slot.
 * Nothing here connects to a database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const TAG = "0113_worker_portfolio";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");
const DDL = RAW.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const flat = (s: string): string => s.replace(/\s+/g, " ");
const FLAT = flat(DDL);

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

describe("the fixture is real", () => {
  it("reads a migration that creates the table with the invariant", () => {
    expect(FLAT).toContain('CREATE TABLE "worker_portfolio"');
    expect(FLAT).toContain('CONSTRAINT "wp_content_chk"');
    expect(FLAT).toContain('CONSTRAINT "wp_kind_chk"');
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("worker_portfolio: work samples");
    expect(DDL).not.toContain("work samples");
  });
});

describe("0113 is additive", () => {
  it("alters only the new table and drops nothing", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1] as string);
    expect([...new Set(altered)]).toEqual(["worker_portfolio"]);
    for (const verb of ["DROP TABLE", "DROP COLUMN", "TRUNCATE"]) {
      expect(FLAT.toUpperCase()).not.toContain(verb);
    }
    expect(FLAT.toUpperCase()).not.toContain('UPDATE "');
  });

  it("states the rollback and holds the only 0113 slot", () => {
    expect(RAW).toContain('DROP TABLE "worker_portfolio"');
    const entry = JOURNAL.entries.find((e) => e.tag === TAG);
    expect(entry?.idx).toBe(113);
    const sorted = [...JOURNAL.entries].sort((a, b) => a.idx - b.idx);
    const at = sorted.findIndex((e) => e.tag === TAG);
    expect(sorted[at - 1]?.idx).toBe(112);
  });
});

describe("the content invariant", () => {
  it("photo/video carry a storage_key and no url; a link carries a url and no storage_key", () => {
    const chk = FLAT.match(/"wp_content_chk" CHECK \(\(([^;]*?)\)\)/)?.[1] ?? "";
    expect(chk).toContain("photo");
    expect(chk).toContain("video");
    expect(chk).toContain("link");
    expect(chk).toContain("storage_key");
    expect(chk).toContain("IS NOT NULL");
    expect(chk).toContain("IS NULL");
  });

  it("a link must be http(s)", () => {
    expect(FLAT).toMatch(/"wp_url_scheme_chk" CHECK[^;]*\^\[?https\?/);
  });

  it("RLS is forced and every role revoked, with no policy", () => {
    expect(FLAT).toContain('ALTER TABLE "worker_portfolio" FORCE ROW LEVEL SECURITY');
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      expect(FLAT).toContain(`REVOKE ALL ON TABLE "worker_portfolio" FROM ${role}`);
    }
    expect(FLAT.toUpperCase()).not.toContain("CREATE POLICY");
  });
});
