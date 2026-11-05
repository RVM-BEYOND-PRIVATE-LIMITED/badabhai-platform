/**
 * Migration 0147 — widen the two `role_kind` CHECKs with the 25th declared kind
 * (Heat-Treatment Technician, CEO Launch Plan Pack v1 Phase 2 #8).
 *
 * Pinned beyond the drift check: DROP + ADD on both tables and nothing else (no
 * column, no backfill), both CHECKs NULL-tolerant and closing EXACTLY the 24
 * kinds declared when this was written (a frozen record), the LIVE model's two
 * CHECKs agreeing with the shared `TRADE_FORM_KINDS_ALL` (the tripwire that
 * outlives this file), the APPLY-BEFORE-DEPLOY instruction and rollback stated,
 * and the slot. Nothing here connects to a database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const TAG = "0147_job_role_kind_heat";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");
const DDL = RAW.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const flat = (s: string): string => s.replace(/\s+/g, " ");
const FLAT = flat(DDL);

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

/** The 25 declared kinds as of 0147 — `TRADE_FORM_KINDS_ALL` on the day it was written. */
const KINDS_0147 = [
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
] as const;

const CHECKS = ["job_postings_role_kind_chk", "jobs_role_kind_chk"] as const;

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
    expect(FLAT).toContain('DROP CONSTRAINT "job_postings_role_kind_chk"');
    expect(FLAT).toContain('DROP CONSTRAINT "jobs_role_kind_chk"');
    for (const name of CHECKS) expect(listed(checkText(name)).length).toBe(25);
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    expect(RAW).toContain("ROLLBACK");
    expect(DDL).not.toContain("ROLLBACK");
  });
});

describe("0147 is DROP + ADD and nothing else", () => {
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
  it.each(CHECKS)("%s closes EXACTLY the 25 kinds declared when it was written", (name) => {
    const kinds = listed(checkText(name));
    expect([...kinds].sort()).toEqual([...KINDS_0147].sort());
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("the two lists are identical — the same vocabulary on both entities", () => {
    expect(listed(checkText(CHECKS[0]))).toEqual(listed(checkText(CHECKS[1])));
  });
});

describe("the slot", () => {
  it("holds the only 0147 journal entry, after 0146, with a later `when`", () => {
    const entry = JOURNAL.entries.find((e) => e.tag === TAG);
    expect(entry?.idx).toBe(147);
    expect(JOURNAL.entries.filter((e) => e.idx === 147)).toHaveLength(1);
    const sorted = [...JOURNAL.entries].sort((a, b) => a.idx - b.idx);
    const at = sorted.findIndex((e) => e.tag === TAG);
    expect(sorted[at - 1]?.idx).toBe(146);
    expect(sorted[at]!.when).toBeGreaterThan(sorted[at - 1]!.when);
  });

  it("states APPLY-BEFORE-DEPLOY and the rollback", () => {
    expect(RAW).toContain("APPLY-BEFORE-DEPLOY");
    expect(RAW).toContain('DROP CONSTRAINT "job_postings_role_kind_chk"');
    expect(RAW).toContain('"role_kind" = \'heat_treatment_technician\'');
  });
});
