/**
 * The `admin_candidate_index` model — B4 (#2557), migration 0156.
 *
 * This file exists because of the failure it now prevents. `0156` creates the tables on every
 * database, and `export * from "./admin-candidate-index"` was enough for drizzle-kit (which reads
 * the module's exports, so the snapshot always had it) — but NOT for the barrel's hand-maintained
 * `schema` object. The e2e RLS drift guard compares `live.size` against
 * `Object.keys(schema).length`, so the omission surfaced as `expected 104 to be 102`: a bare count
 * that names no table, in a suite that has nothing to do with this one. Every other table carries
 * the same registration check for the same reason.
 */
import { describe, expect, it } from "vitest";

import { schema } from "./schema";
import { adminCandidateIndex, adminCandidateIndexCursor } from "./schema/admin-candidate-index";

describe("admin_candidate_index is registered in the model", () => {
  it("is in the exported schema object, not only re-exported from the module", () => {
    // `export *` satisfies drizzle-kit and the type surface; it does NOT put the table in
    // `schema`. Both are required, and only this assertion names the table when one is missing.
    expect(Object.keys(schema)).toContain("adminCandidateIndex");
    expect(Object.keys(schema)).toContain("adminCandidateIndexCursor");
    expect(schema.adminCandidateIndex).toBe(adminCandidateIndex);
    expect(schema.adminCandidateIndexCursor).toBe(adminCandidateIndexCursor);
  });

  it("carries no plaintext identity column (lookup hashes only, ADR-0062 §9)", () => {
    // The table may hold `phoneHash` (exact lookup) and `nameTokenHashes` (whole-word
    // HMACs) — never a name, phone, email, or any other raw identity. A column that could
    // carry one must fail here, not in a later audit. Keys are the camelCase model
    // properties (drizzle maps them to snake_case columns).
    const columns = Object.keys(adminCandidateIndex);
    for (const banned of [
      "fullName",
      "name",
      "orgName",
      "phoneE164",
      "phone",
      "email",
      "whatsapp",
      "employerName",
    ]) {
      expect(columns, `no ${banned} column`).not.toContain(banned);
    }
    expect(columns).toContain("phoneHash");
    expect(columns).toContain("nameTokenHashes");
  });
});
