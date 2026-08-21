/**
 * The `_delete_forensics` model — #1110, declared by `0086`.
 *
 * This file exists because of the failure it now prevents. `0086` creates the table on every
 * database, and `export * from "./delete-forensics"` was enough for drizzle-kit (which reads the
 * module's exports, so the snapshot always had it) — but NOT for the barrel's hand-maintained
 * `schema` object. The e2e RLS drift guard compares `live.size` against
 * `Object.keys(schema).length`, so the omission surfaced as `expected 78 to be 77`: a bare count
 * that names no table, in a suite that has nothing to do with this one. Every other table carries
 * the same registration check for the same reason.
 */
import { describe, expect, it } from "vitest";

import { schema } from "./schema";
import { DELETE_FORENSICS_RETENTION_DAYS, deleteForensics } from "./schema/delete-forensics";

describe("_delete_forensics is registered in the model", () => {
  it("is in the exported schema object, not only re-exported from the module", () => {
    // `export *` satisfies drizzle-kit and the type surface; it does NOT put the table in
    // `schema`. Both are required, and only this assertion names the table when one is missing.
    expect(Object.keys(schema)).toContain("deleteForensics");
    expect(schema.deleteForensics).toBe(deleteForensics);
  });

  it("carries neither column 0086 dropped", () => {
    // The model is the second place a dropped column can come back: re-adding it here and
    // regenerating would emit an ALTER that silently restores the exposure #1110 closed.
    const columns = Object.keys(deleteForensics);
    expect(columns).not.toContain("query");
    expect(columns).not.toContain("clientAddr");
    expect(columns).not.toContain("client_addr");
  });

  it("keeps the columns the erasure trail is actually for", () => {
    // Narrowed, not gutted. If a later change empties this table of everything that identifies
    // a deletion, the DPDP forensic value is gone and nothing else would say so.
    for (const c of ["at", "txid", "tableName", "rowId", "workerId", "dbUser", "appName", "backendPid"]) {
      expect(Object.keys(deleteForensics)).toContain(c);
    }
  });

  it("has one retention constant, and it is the bounded one", () => {
    expect(DELETE_FORENSICS_RETENTION_DAYS).toBe(90);
  });
});
