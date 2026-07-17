import { describe, expect, it } from "vitest";

import { SKILL_TAXONOMY_VERSION } from "@badabhai/taxonomy";

import { workerProfiles, type NewWorkerProfile } from "./schema";

// B-6 (context-drift register 2026-07-16): worker_profiles.taxonomy_version is the
// SKILL_TAXONOMY_VERSION in force when `skills` was last WRITTEN. The contract this
// file pins: the column stays ADDITIVE-NULLABLE (old rows are untouched — a NULL
// honestly means "written before versioning existed"), and the stamp is derivable
// from the exported constant (String(...) — the column is text so a future version
// scheme needs no lossy migration).
describe("worker_profiles.taxonomy_version — B-6 additive version stamp", () => {
  it("maps to the taxonomy_version column, NULLABLE with NO default (old rows unaffected)", () => {
    const col = workerProfiles.taxonomyVersion;
    expect(col.name).toBe("taxonomy_version");
    expect(col.notNull).toBe(false); // nullable — migration 0041 backfills NOTHING by design
    expect(col.hasDefault).toBe(false); // absence of a stamp must stay honest, never defaulted
  });

  it("an old-shape insert WITHOUT the stamp still typechecks (backward-compatible write contract)", () => {
    // Pre-B-6 callers (seeds, fixtures, legacy paths) omit the field entirely.
    const legacyInsert: NewWorkerProfile = {
      workerId: "11111111-1111-4111-8111-111111111111",
      skills: ["skill_milling"],
    };
    expect(legacyInsert.taxonomyVersion).toBeUndefined();
  });

  it("the stamp value is the exported @badabhai/taxonomy constant, stringified", () => {
    // The write paths (extraction processor, TAX-9 retag) stamp String(SKILL_TAXONOMY_VERSION).
    expect(String(SKILL_TAXONOMY_VERSION)).toMatch(/^\d+$/);
    expect(SKILL_TAXONOMY_VERSION).toBeGreaterThanOrEqual(1);
  });
});
