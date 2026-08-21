/**
 * The exclusion file is the only thing standing between a routine backfill and the silent
 * reversal of a reviewed taxonomy decision, so it fails closed: a malformed file stops the
 * runner rather than degrading to "no exclusions", which would look exactly like success.
 */
import { describe, expect, it } from "vitest";

import { excludedAliasIds, loadAliasExclusions, parseAliasExclusions } from "./alias-exclusions";

const ID_A = "d197cbbe-350d-5de3-8fee-f0a37aecfe58";
const ID_B = "401212eb-e7f2-57ba-853a-7a4f7515fb24";

const ok = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    kind: "alias-exclusions",
    exclusions: [
      {
        alias_id: ID_A,
        skill_id: "skill_gdt_reading",
        text: "blueprint reading",
        domain_id: "cnc-machining",
        winner_skill_id: "skill_drawing_reading",
        reason: "cross-skill alias collision",
        decided_by: "product owner",
        phase: "9 / Stage B",
        ...over,
      },
    ],
  });

describe("parseAliasExclusions", () => {
  it("accepts a well-formed file", () => {
    const x = parseAliasExclusions(ok());
    expect(x).toHaveLength(1);
    expect(x[0]?.alias_id).toBe(ID_A);
  });

  it("refuses invalid JSON rather than treating it as empty", () => {
    expect(() => parseAliasExclusions("{nope")).toThrow(/not valid JSON/);
  });

  it("refuses a file of the wrong kind — a paste of the wrong evidence file is a real mistake", () => {
    expect(() => parseAliasExclusions(JSON.stringify({ kind: "path-b-parity", exclusions: [] }))).toThrow(/wrong kind/);
  });

  it("refuses a non-uuid alias_id", () => {
    expect(() => parseAliasExclusions(ok({ alias_id: "skill_gdt_reading" }))).toThrow(/not a uuid/);
  });

  it("refuses an empty reason — the record is worthless without one", () => {
    expect(() => parseAliasExclusions(ok({ reason: "  " }))).toThrow(/"reason" must be a non-empty string/);
  });

  it("refuses an empty decided_by", () => {
    expect(() => parseAliasExclusions(ok({ decided_by: "" }))).toThrow(/"decided_by"/);
  });

  it("refuses a winner that is the losing skill itself", () => {
    expect(() => parseAliasExclusions(ok({ winner_skill_id: "skill_gdt_reading" }))).toThrow(/winner_skill_id equals skill_id/);
  });

  it("refuses duplicate alias_ids", () => {
    const doc = JSON.parse(ok()) as { exclusions: unknown[] };
    doc.exclusions.push(doc.exclusions[0]);
    expect(() => parseAliasExclusions(JSON.stringify(doc))).toThrow(/duplicate alias_id/);
  });

  it("allows a null winner — a text retired outright, not moved", () => {
    expect(parseAliasExclusions(ok({ winner_skill_id: null }))[0]?.winner_skill_id).toBeNull();
  });
});

describe("loadAliasExclusions — the committed file", () => {
  it("treats a missing file as legitimately empty", () => {
    expect(loadAliasExclusions("data/taxonomy/does-not-exist.json")).toEqual([]);
  });

  it("the shipped file parses and carries the four 2026-08-21 de-elections", () => {
    // Anchored to the real file, so editing it carelessly breaks a test rather than production.
    const x = loadAliasExclusions();
    expect(x.length).toBeGreaterThanOrEqual(4);
    const ids = new Set(x.map((e) => e.alias_id));
    expect(ids.has(ID_A)).toBe(true);
    expect(ids.has(ID_B)).toBe(true);
    for (const e of x) {
      expect(e.reason.length).toBeGreaterThan(10);
      expect(e.decided_by).not.toBe("");
    }
  });

  it("every de-elected text still has a winner that is a DIFFERENT skill", () => {
    for (const e of loadAliasExclusions()) {
      if (e.winner_skill_id !== null) expect(e.winner_skill_id).not.toBe(e.skill_id);
    }
  });

  it("excludedAliasIds returns exactly the ids, in file order", () => {
    expect(excludedAliasIds()).toEqual(loadAliasExclusions().map((e) => e.alias_id));
  });
});
