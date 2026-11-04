/**
 * Migration 0150 — widen the two `worker_resume_import` role-kind CHECKs with the
 * 26th declared kind (Production Supervisor, CEO Launch Plan Pack v1 Phase 2 #10).
 *
 * Pinned beyond the drift check: DROP + ADD on one table and nothing else (no column,
 * no backfill), both CHECKs NULL-tolerant and closing EXACTLY the 26 kinds declared
 * when this was written (a frozen record), the LIVE model's two CHECKs agreeing with
 * the shared `TRADE_FORM_KINDS_ALL` (the tripwire that outlives this file — see
 * `migration-0124-resume-identity-role-kind.test.ts`), the APPLY-BEFORE-DEPLOY
 * instruction and rollback stated, and the slot. Nothing here connects to a database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const TAG = "0150_wri_role_kind_production_supervisor";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");
const DDL = RAW.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const flat = (s: string): string => s.replace(/\s+/g, " ");
const FLAT = flat(DDL);

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

/** The 26 declared kinds as of 0150 — `TRADE_FORM_KINDS_ALL` on the day it was written. */
const KINDS_0150 = [
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
  "injection_moulding_operator",
  "mould_die_maker",
  "blow_moulding_operator",
  "rubber_moulding_operator",
  "plastic_process_technician",
  "cad_designer_3d",
  "plc_automation_technician",
  "edm_wirecut_operator",
  "heat_treatment_technician",
  "production_supervisor",
] as const;

const CHECKS = ["wri_association_kind_chk", "wri_identity_role_kind_chk"] as const;

const checkText = (name: string): string => {
  const start = FLAT.indexOf(`"${name}" CHECK`);
  if (start < 0) return "";
  const end = FLAT.indexOf(";", start);
  return end < 0 ? FLAT.slice(start) : FLAT.slice(start, end);
};
const listed = (text: string): string[] =>
  [...text.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1] as string);

describe("the fixture is real", () => {
  it("reads a migration that drops and re-adds both CHECKs", () => {
    expect(FLAT).toContain('DROP CONSTRAINT "wri_association_kind_chk"');
    expect(FLAT).toContain('DROP CONSTRAINT "wri_identity_role_kind_chk"');
    for (const name of CHECKS) expect(listed(checkText(name)).length).toBe(26);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("ROLLBACK");
    expect(DDL).not.toContain("ROLLBACK");
  });
});

describe("0150 is DROP + ADD and nothing else", () => {
  it("is exactly two DROPs and two ADDs — no column, no backfill", () => {
    const statements = FLAT.split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements).toHaveLength(4);
    expect((FLAT.match(/DROP CONSTRAINT/g) ?? []).length).toBe(2);
    expect((FLAT.match(/ADD CONSTRAINT/g) ?? []).length).toBe(2);
    expect(FLAT).not.toContain("ADD COLUMN");
  });

  it("both CHECKs are NULL-tolerant — no picked role stays writable", () => {
    for (const name of CHECKS) expect(checkText(name)).toContain("IS NULL");
  });
});

describe("the CHECKs in the migration — a FROZEN record", () => {
  it.each(CHECKS)("%s closes EXACTLY the 26 kinds declared when it was written", (name) => {
    const kinds = listed(checkText(name));
    expect([...kinds].sort()).toEqual([...KINDS_0150].sort());
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("the two lists are identical — the same vocabulary on both CHECKs", () => {
    expect(listed(checkText(CHECKS[0]))).toEqual(listed(checkText(CHECKS[1])));
  });
});

describe("the slot", () => {
  it("holds the only 0150 journal entry, after 0149, with a later `when`", () => {
    const entry = JOURNAL.entries.find((e) => e.tag === TAG);
    expect(entry?.idx).toBe(150);
    expect(JOURNAL.entries.filter((e) => e.idx === 150)).toHaveLength(1);
    const sorted = [...JOURNAL.entries].sort((a, b) => a.idx - b.idx);
    const at = sorted.findIndex((e) => e.tag === TAG);
    expect(sorted[at - 1]?.idx).toBe(149);
    expect(sorted[at]!.when).toBeGreaterThan(sorted[at - 1]!.when);
  });

  it("states APPLY-BEFORE-DEPLOY and the rollback", () => {
    expect(RAW).toContain("APPLY-BEFORE-DEPLOY");
    expect(RAW).toContain('DROP CONSTRAINT "wri_identity_role_kind_chk"');
    expect(RAW).toContain("\"identity_role_kind\" = 'production_supervisor'");
  });
});
