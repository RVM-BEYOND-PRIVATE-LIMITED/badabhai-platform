import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  declaredRoutines,
  declaredTables,
  drift,
  isClean,
  isNotOurs,
  type DeclaredTable,
  type LiveTable,
} from "./audit-live-drift";

const t = (table: string, ...columns: string[]): LiveTable & DeclaredTable => ({ table, columns });

describe("drift — the four directions, each pinned separately", () => {
  it("is clean when both sides name the same tables and columns", () => {
    const both = [t("workers", "id", "phone"), t("jobs", "id", "trade_key")];
    const d = drift(both, both);
    expect(isClean(d)).toBe(true);
  });

  it("reports a table the database has and no schema file declares — the GAP-DB-21 direction", () => {
    const d = drift([t("workers", "id"), t("payer_capabilities", "id")], [t("workers", "id")]);
    expect(d.undeclaredTables).toEqual(["payer_capabilities"]);
    expect(d.missingTables).toEqual([]);
  });

  it("reports a table Drizzle declares that the database does not have", () => {
    const d = drift([t("workers", "id")], [t("workers", "id"), t("ghost", "id")]);
    expect(d.missingTables).toEqual(["ghost"]);
  });

  it("reports columns in both directions on a table both sides have", () => {
    const d = drift([t("payers", "id", "metadata")], [t("payers", "id", "tier")]);
    expect(d.undeclaredColumns).toEqual(["payers.metadata"]);
    expect(d.missingColumns).toEqual(["payers.tier"]);
  });

  it("does NOT report columns for a table that is already reported as missing", () => {
    // Otherwise one absent table produces one table finding plus one finding per column, and the
    // count stops meaning anything.
    const d = drift([], [t("ghost", "a", "b", "c")]);
    expect(d.missingTables).toEqual(["ghost"]);
    expect(d.missingColumns).toEqual([]);
  });

  it("suppresses names the database owns and we never model", () => {
    expect(isNotOurs("__drizzle_migrations")).toBe(true);
    expect(isNotOurs("workers")).toBe(false);
    const d = drift([t("__drizzle_migrations", "id")], []);
    expect(d.undeclaredTables).toEqual([]);
  });

  it("sorts every list, so two runs against the same database compare byte for byte", () => {
    const d = drift([t("b", "z", "a"), t("a", "q")], []);
    expect(d.undeclaredTables).toEqual(["a", "b"]);
  });
});

describe("declaredTables — reads the real Drizzle schema", () => {
  it("finds the tables this repository actually models", () => {
    const names = declaredTables().map((x) => x.table);
    expect(names).toContain("workers");
    expect(names).toContain("job_reach");
    expect(names.length).toBeGreaterThan(50);
  });

  it("declares no duplicates, so a table aliased twice cannot double-count", () => {
    const names = declaredTables().map((x) => x.table);
    expect(new Set(names).size).toBe(names.length);
  });

  it("does NOT declare the four GAP-DB-21 tables — that is the whole finding", () => {
    const names = new Set(declaredTables().map((x) => x.table));
    for (const t of ["agency_profiles", "employer_profiles", "payer_capabilities", "payer_member_invites"]) {
      expect(names.has(t)).toBe(false);
    }
  });
});

describe("declaredRoutines — the migration text is the only declaration there is", () => {
  const dir = join(__dirname, "..", "migrations");

  it("reads CREATE TRIGGER and CREATE [OR REPLACE] FUNCTION out of the real migrations", () => {
    // As of 2026-08-20 both sets are EMPTY, and that is the finding rather than a parser bug:
    // 83 migration files create no trigger and no function, while production runs two triggers,
    // three non-extension functions and an `ensure_rls` event trigger that changes what a
    // CREATE TABLE means. The assertion is deliberately not `toEqual(new Set())` — it must keep
    // passing on the day someone declares one.
    const r = declaredRoutines(dir);
    expect(r.triggers).toBeInstanceOf(Set);
    expect(r.functions).toBeInstanceOf(Set);
  });

  it("parses each form, including quoted and schema-qualified names", () => {
    const tmp = mkdtempSync(join(tmpdir(), "live-drift-"));
    writeFileSync(
      join(tmp, "0001_x.sql"),
      [
        `CREATE FUNCTION public._log_delete() RETURNS trigger AS $$ BEGIN END $$ LANGUAGE plpgsql;`,
        `CREATE OR REPLACE FUNCTION "rls_auto_enable"() RETURNS event_trigger AS $$ BEGIN END $$ LANGUAGE plpgsql;`,
        `CREATE TRIGGER _t_log_del_workers AFTER DELETE ON workers FOR EACH ROW EXECUTE FUNCTION _log_delete();`,
        `CREATE CONSTRAINT TRIGGER "deferred_check" AFTER INSERT ON t DEFERRABLE FOR EACH ROW EXECUTE FUNCTION f();`,
      ].join("\n"),
      "utf8",
    );

    const r = declaredRoutines(tmp);
    expect([...r.functions].sort()).toEqual(["_log_delete", "rls_auto_enable"]);
    expect([...r.triggers].sort()).toEqual(["_t_log_del_workers", "deferred_check"]);
  });

  it("ignores non-.sql files, so a stray note cannot declare a trigger", () => {
    const tmp = mkdtempSync(join(tmpdir(), "live-drift-"));
    writeFileSync(join(tmp, "README.md"), "CREATE TRIGGER not_real ON t ...", "utf8");
    expect(declaredRoutines(tmp).triggers.size).toBe(0);
  });
});
