/**
 * Migration 0124 — `wri_identity_role_kind_chk` widened from the 9 ENABLED kinds to the 21
 * DECLARED ones.
 *
 * 0118 closed `identity_role_kind` on the enabled form kinds and asked that every `formEnabled`
 * flip widen it in the same change. The first flip after it (#1693, sheet metal) did not, and the
 * résumé summary's identity write started failing the CHECK for the one trade just launched —
 * caught, so invisible, but losing the staged line and re-billing the call on retry.
 *
 * Pinned beyond the drift check: the CHECK closes EXACTLY the shared `TRADE_FORM_KINDS_ALL`
 * constant (so no future flip can reopen the hole), it stays NULL-tolerant, it keeps every value
 * 0118 allowed (so no stored row can fail the re-add), nothing else is touched, and the rollback
 * and the slot are stated. Nothing here connects to a database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TRADE_FORM_KINDS_ALL } from "@badabhai/types";
import { describe, expect, it } from "vitest";

const TAG = "0124_resume_identity_role_kind_declared";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");
const DDL = RAW.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const flat = (s: string): string => s.replace(/\s+/g, " ");
const FLAT = flat(DDL);

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

/** The nine kinds 0118 allowed. Every one must survive, or a stored row fails the re-add. */
const KINDS_0118 = [
  "cnc_turner",
  "vmc_milling",
  "cnc_grinding",
  "conventional_machinist",
  "tool_die_maker",
  "cam_programmer",
  "cad_draughtsman",
  "welder",
  "painter_coating",
] as const;

const chk = FLAT.match(/"wri_identity_role_kind_chk" CHECK[^;]*/)?.[0] ?? "";
const listed = [...chk.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);

describe("the fixture is real", () => {
  it("reads a migration that re-adds the identity CHECK", () => {
    expect(FLAT).toContain('DROP CONSTRAINT "wri_identity_role_kind_chk"');
    expect(FLAT).toContain('ADD CONSTRAINT "wri_identity_role_kind_chk"');
    expect(listed.length).toBeGreaterThan(0);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    // The header's ROLLBACK block spells out the old nine-kind CHECK. Without stripping it, the
    // "old list" would be in FLAT twice and the list assertions below could pass on prose.
    expect(RAW).toContain("THE DEFECT.");
    expect(DDL).not.toContain("THE DEFECT.");
  });
});

describe("0124 touches one constraint and nothing else", () => {
  it("alters only worker_resume_import, and only this CHECK", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1] as string);
    expect([...new Set(altered)]).toEqual(["worker_resume_import"]);
    const dropped = [...FLAT.matchAll(/DROP CONSTRAINT "([a-z_]+)"/g)].map((m) => m[1]);
    expect(dropped).toEqual(["wri_identity_role_kind_chk"]);
    for (const verb of ["DROP COLUMN", "ADD COLUMN", "DROP TABLE", "TRUNCATE", "UPDATE "]) {
      expect(FLAT.toUpperCase()).not.toContain(verb);
    }
  });

  it("states the rollback and holds the only 0124 slot", () => {
    expect(RAW).toContain("ROLLBACK");
    expect(RAW).toContain('DROP CONSTRAINT "wri_identity_role_kind_chk"');
    const entry = JOURNAL.entries.find((e) => e.tag === TAG);
    expect(entry?.idx).toBe(124);
    const sorted = [...JOURNAL.entries].sort((a, b) => a.idx - b.idx);
    const at = sorted.findIndex((e) => e.tag === TAG);
    expect(sorted[at - 1]?.idx).toBe(123);
    expect(sorted[at]?.when).toBeGreaterThan(sorted[at - 1]!.when);
  });
});

describe("the widened CHECK", () => {
  it("is NULL-tolerant — a row summarized before the call existed must stay writable", () => {
    expect(chk).toContain("IS NULL");
  });

  it("closes EXACTLY the 21 declared kinds of the shared constant", () => {
    // THE POINT OF THE MIGRATION. Tied to `TRADE_FORM_KINDS_ALL`, not to the enabled subset, so
    // enabling a form can never again need a migration it can forget — and a 22nd DECLARED kind
    // makes this red until the constraint is widened with it.
    expect([...listed].sort()).toEqual([...TRADE_FORM_KINDS_ALL].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("keeps every kind 0118 allowed, so no stored row can fail the re-add", () => {
    for (const kind of KINDS_0118) expect(listed).toContain(kind);
  });

  it("admits the kind whose flip exposed the hole", () => {
    expect(listed).toContain("sheet_metal_worker");
  });
});
