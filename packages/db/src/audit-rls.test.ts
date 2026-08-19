/**
 * The RLS sweep's classification.
 *
 * The assertion that carries this file is the SEVERITY SPLIT. "RLS is on with no policies, so
 * everything is denied" is the intuition that lets a grant survive review, and it is wrong for
 * exactly one role: `service_role` has `rolbypassrls`, so RLS never filters it and the GRANT is
 * the only control. A tool that reported both grants identically would let the reader triage
 * the dangerous one last.
 */
import { describe, expect, it } from "vitest";

import { RLS_BYPASSING_ROLES, remediationSql, rlsFindings, type TableRls } from "./audit-rls";

const locked: TableRls = { table: "workers", enabled: true, forced: true, grantedRoles: ["postgres"] };

describe("rlsFindings", () => {
  it("reports nothing for a table that is enabled, forced, and owner-only", () => {
    expect(rlsFindings(locked)).toEqual([]);
  });

  it("ranks a service_role grant FIRST, because RLS does not filter it", () => {
    const f = rlsFindings({ ...locked, grantedRoles: ["postgres", "anon", "service_role"] });
    expect(f[0]?.problem).toBe("granted-to-bypassing-role");
    expect(f[0]?.detail).toMatch(/only control/);
  });

  it("separates a filtered grant from a bypassing one rather than lumping them together", () => {
    const f = rlsFindings({ ...locked, grantedRoles: ["postgres", "anon", "authenticated"] });
    expect(f.map((x) => x.problem)).toEqual(["granted-to-data-api-role"]);
    // The detail must NOT claim the rows are reachable — with RLS on and no policy they are not.
    expect(f[0]?.detail).toMatch(/RLS still filters them/);
  });

  it("flags enabled-but-not-forced", () => {
    expect(rlsFindings({ ...locked, forced: false }).map((x) => x.problem)).toEqual(["not-forced"]);
  });

  it("reports rls-off INSTEAD of not-forced, not as well as", () => {
    // Both would be true, and printing two lines for one fact makes the report harder to act on.
    const f = rlsFindings({ ...locked, enabled: false, forced: false });
    expect(f.map((x) => x.problem)).toEqual(["rls-off"]);
  });

  it("reports every distinct problem when a table has more than one", () => {
    const f = rlsFindings({ table: "t", enabled: true, forced: false, grantedRoles: ["anon", "service_role"] });
    expect(f.map((x) => x.problem).sort()).toEqual(
      ["granted-to-bypassing-role", "granted-to-data-api-role", "not-forced"].sort(),
    );
  });

  it("never flags the owner's own grant", () => {
    // `postgres` is the backend's connection. Revoking it would take the application down, and
    // FORCE is what governs the owner instead.
    expect(rlsFindings({ ...locked, grantedRoles: ["postgres"] })).toEqual([]);
    expect(RLS_BYPASSING_ROLES).not.toContain("postgres");
  });

  it("matches role names case-insensitively", () => {
    expect(rlsFindings({ ...locked, grantedRoles: ["SERVICE_ROLE"] })[0]?.problem).toBe(
      "granted-to-bypassing-role",
    );
  });
});

describe("remediationSql", () => {
  it("emits nothing for a locked table", () => {
    expect(remediationSql(locked)).toEqual([]);
  });

  it("enables before it forces, because FORCE alone is not valid on an unprotected table", () => {
    const sql = remediationSql({ table: "t", enabled: false, forced: false, grantedRoles: [] });
    expect(sql[0]).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql[1]).toMatch(/FORCE ROW LEVEL SECURITY/);
  });

  it("revokes only the roles that actually hold a grant", () => {
    const sql = remediationSql({ table: "t", enabled: true, forced: true, grantedRoles: ["postgres", "anon"] });
    expect(sql).toEqual(['REVOKE ALL ON TABLE "t" FROM anon;']);
  });

  it("never revokes from the owner", () => {
    const sql = remediationSql({ table: "t", enabled: true, forced: true, grantedRoles: ["postgres"] });
    expect(sql.join("\n")).not.toContain("postgres");
  });

  it("quotes the table name, so a reserved word or mixed case still produces valid SQL", () => {
    expect(remediationSql({ table: "user", enabled: false, forced: false, grantedRoles: [] })[0]).toContain('"user"');
  });
});
