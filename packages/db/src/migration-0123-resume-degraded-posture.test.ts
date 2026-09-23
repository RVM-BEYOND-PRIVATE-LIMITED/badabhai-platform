/**
 * Migration 0123 — `worker_resume_import.degraded_posture` (#1656).
 *
 * 0122 recorded HOW MUCH a parse yielded. This records WHY it yielded nothing when the DOCUMENT
 * was not at fault: a spend cap, a provider cooldown, a cost ceiling or the kill switch sends the
 * AI router to the deterministic mock, whose reply is contract-valid with zero fields and no
 * failure reason. The import settled `parsed`, routed to chat, and emitted
 * `profile.resume_parsed` with `fields_extracted: 0` — byte for byte what a document carrying
 * none of the eight target fields produces. So "how often does our parser let a worker down"
 * counted spend-capped no-ops as successful parses.
 *
 * Pinned beyond the drift check: additive-only, one nullable column with no default, the
 * two-value CHECK tied to the ONE constant three packages share, the rollback and the slot.
 * Nothing here connects to a database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { RESUME_DEGRADED_POSTURES } from "@badabhai/types";
import { describe, expect, it } from "vitest";

const TAG = "0123_resume_degraded_posture";
const RAW = readFileSync(join(__dirname, "..", "migrations", `${TAG}.sql`), "utf8");
const DDL = RAW.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const flat = (s: string): string => s.replace(/\s+/g, " ");
const FLAT = flat(DDL);

const JOURNAL = JSON.parse(
  readFileSync(join(__dirname, "..", "migrations", "meta", "_journal.json"), "utf8"),
) as { entries: { idx: number; when: number; tag: string }[] };

describe("the fixture is real", () => {
  it("reads a migration that adds the column and the vocabulary CHECK", () => {
    expect(FLAT).toContain('ADD COLUMN "degraded_posture" text');
    expect(FLAT).toContain('CONSTRAINT "wri_degraded_posture_chk"');
  });

  it("strips the header, so prose cannot satisfy a DDL assertion", () => {
    // The header explains the defect at length and names both codes. Without this, every
    // assertion below would pass against the comment rather than the statements.
    expect(RAW).toContain("an INCIDENT: a provider was reached and failed");
    expect(DDL).not.toContain("INCIDENT");
  });
});

describe("0123 is additive", () => {
  it("touches only worker_resume_import, adds ONE column, and drops nothing", () => {
    const altered = [...FLAT.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1] as string);
    expect([...new Set(altered)]).toEqual(["worker_resume_import"]);
    expect((FLAT.match(/ADD COLUMN/g) ?? []).length).toBe(1);
    for (const verb of ["DROP COLUMN", "DROP TABLE", "TRUNCATE", "UPDATE "]) {
      expect(FLAT.toUpperCase()).not.toContain(verb);
    }
  });

  it("the column is NULLABLE with no default — catalog-only, and no backfill", () => {
    // NO BACKFILL IS THE POINT. A default would make every row already in the table claim a
    // posture nobody observed, and a NOT NULL would rewrite the table to say it.
    const line = FLAT.match(/ADD COLUMN "degraded_posture"[^;]*/)?.[0] ?? "";
    expect(line).not.toContain("NOT NULL");
    expect(line).not.toContain("DEFAULT");
  });

  it("states the rollback and holds the only 0123 slot", () => {
    expect(RAW).toContain('DROP CONSTRAINT "wri_degraded_posture_chk"');
    expect(RAW).toContain('DROP COLUMN "degraded_posture"');
    const entry = JOURNAL.entries.find((e) => e.tag === TAG);
    expect(entry?.idx).toBe(123);
    const sorted = [...JOURNAL.entries].sort((a, b) => a.idx - b.idx);
    const at = sorted.findIndex((e) => e.tag === TAG);
    expect(sorted[at - 1]?.idx).toBe(122);
    expect(sorted[at]?.when).toBeGreaterThan(sorted[at - 1]!.when);
  });
});

describe("the vocabulary CHECK", () => {
  const chk = FLAT.match(/"wri_degraded_posture_chk" CHECK[^;]*/)?.[0] ?? "";

  it("is NULL-tolerant — NULL is not a posture and must stay writable", () => {
    // NULL means "parsed before this column existed" OR "parsed with no degraded posture".
    // Neither is a fact a consumer may read as "degraded", and a CHECK that refused NULL
    // would make every pre-0123 row unupdatable.
    expect(chk).toContain("IS NULL");
  });

  it("closes EXACTLY the shared constant's two codes", () => {
    // The same two values are a `z.enum` on `profile.resume_parsed` and the filter in
    // `ResumeParseService`. Three copies that can drift is how an event the registry refuses
    // gets emitted for a row the database happily stored, so this pins the SQL to the constant.
    for (const code of RESUME_DEGRADED_POSTURES) expect(chk).toContain(`'${code}'`);
    const quoted = [...chk.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
    expect(new Set(quoted)).toEqual(new Set(RESUME_DEGRADED_POSTURES));
  });

  it("is NOT tied to `status` — a degraded posture is not a failure (ruling D9)", () => {
    // `wri_failure_reason_chk` is a biconditional on `status` because a failure MUST be
    // explicable. This one is a plain membership test: a spend cap still settles `parsed` and
    // still routes, and constraining the column to one status would forbid the failure path
    // from ever recording the truth as well.
    expect(chk).not.toContain("status");
  });

  it("carries no free text and no model output — codes only", () => {
    expect(FLAT).not.toContain("notes");
    expect(FLAT.toLowerCase()).not.toContain("reason_text");
  });
});
