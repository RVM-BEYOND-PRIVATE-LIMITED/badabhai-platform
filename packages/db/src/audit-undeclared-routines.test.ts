/**
 * The undeclared-routines audit — and the one rule it must never break.
 *
 * This tool exists because `_delete_forensics.query` may hold raw PII. A tool written to
 * investigate that must not become the thing that copies it into a terminal, a ticket or a
 * paste, so the "counts only, never values" rule is enforced by a function and driven here in
 * BOTH directions: it passes for the queries that ship, and it fails for a query that projects
 * a value column. A guard that has never been seen to fail is not a guard.
 */
import { describe, expect, it } from "vitest";

import {
  EXECUTE_RISK_ROLES,
  FORENSICS_BY_TABLE_SQL,
  FORENSICS_SQL,
  PII_SHAPES,
  ROUTINES_SQL,
  VALUE_COLUMNS,
  VALUE_COLUMN_PATTERN_KEYS,
  classify,
  isExposedDefiner,
  isOurs,
  render,
  selectsAValueColumn,
  strictProblems,
  type RoutineRow,
} from "./audit-undeclared-routines";
import { DATA_API_ROLES } from "./schema-contract";

const NO_DECLARATIONS = { triggers: new Set<string>(), functions: new Set<string>() };

const raw = (o: Partial<Parameters<typeof classify>[0]> = {}): Parameters<typeof classify>[0] => ({
  kind: "function",
  name: "f",
  owner: "postgres",
  security_definer: false,
  acl: [],
  on_what: null,
  ...o,
});

describe("counts only, never values", () => {
  it("passes every query this file actually ships", () => {
    for (const q of [ROUTINES_SQL, FORENSICS_SQL, FORENSICS_BY_TABLE_SQL]) {
      expect(selectsAValueColumn(q)).toBe(false);
    }
  });

  it("refuses a query that projects a value column", () => {
    // The mutation this guard exists for: someone adds `query` to the SELECT list "just to see".
    expect(selectsAValueColumn("SELECT table_name, query FROM public._delete_forensics")).toBe(true);
    expect(selectsAValueColumn("SELECT client_addr FROM public._delete_forensics")).toBe(true);
    expect(selectsAValueColumn("SELECT at, query, row_id FROM t")).toBe(true);
  });

  it("still allows a value column to be COUNTED, filtered on, or measured", () => {
    // Refusing these would make the guard useless — the whole report is built from them.
    expect(selectsAValueColumn("SELECT count(*) FILTER (WHERE query IS NOT NULL) FROM t")).toBe(false);
    expect(selectsAValueColumn("SELECT max(length(query)) FROM t")).toBe(false);
    expect(
      selectsAValueColumn("SELECT count(*) FILTER (WHERE client_addr IS NOT NULL)::int AS n FROM t"),
    ).toBe(false);
  });

  it("names the columns it protects, so the list is reviewable", () => {
    expect([...VALUE_COLUMNS]).toEqual(["query", "client_addr"]);
  });

  it("keeps the pattern map and the column list in step", () => {
    // The patterns are LITERAL regexes rather than `new RegExp(`…${column}…`)` — semgrep's
    // `detect-non-literal-regexp` blocks the constructed form, and this repo has been bitten by
    // that ReDoS shape before. The cost of literals is that the two lists can drift; this is
    // what stops a third protected column being added to one and forgotten in the other.
    expect([...VALUE_COLUMN_PATTERN_KEYS].sort()).toEqual([...VALUE_COLUMNS].sort());
  });

  it("counts PII by SHAPE, and the shapes are regexes rather than extractors", () => {
    // A shape says "a row here looks like it contains a phone number". It never yields one.
    expect(Object.keys(PII_SHAPES).sort()).toEqual([
      "bare_indian_mobile_literal",
      "email_shaped",
      "phone_e164_shaped",
      "ten_digit_in_literal",
      "ten_digit_run",
    ]);
    for (const [name, pattern] of Object.entries(PII_SHAPES)) {
      expect(FORENSICS_SQL, `${name} must actually be used`).toContain(pattern);
      expect(() => new RegExp(pattern)).not.toThrow();
    }
  });
});

describe("read-only", () => {
  it("issues no statement that could write", () => {
    for (const q of [ROUTINES_SQL, FORENSICS_SQL, FORENSICS_BY_TABLE_SQL]) {
      expect(q).toMatch(/^\s*SELECT\b/);
      expect(q).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i);
    }
  });
});

describe("whose routine is it", () => {
  it("separates our own role from the Supabase platform's", () => {
    // The single column that turns a curiosity into an ownership question. Six of production's
    // seven event triggers are `supabase_admin`'s; `ensure_rls` is not.
    expect(isOurs("postgres")).toBe(true);
    expect(isOurs("supabase_admin")).toBe(false);
    expect(isOurs("supabase_storage_admin")).toBe(false);
  });
});

describe("SECURITY DEFINER + who may execute", () => {
  it("reads PUBLIC out of an empty grantee, which is how proacl spells it", () => {
    const r = classify(raw({ security_definer: true, acl: ["=X/postgres"] }), NO_DECLARATIONS);
    expect(r.executableBy).toEqual(["PUBLIC"]);
    expect(isExposedDefiner(r)).toBe(true);
  });

  it("reports every Data-API role that holds EXECUTE", () => {
    const r = classify(
      raw({
        security_definer: true,
        acl: ["postgres=X/postgres", "anon=X/postgres", "authenticated=X/postgres", "service_role=X/postgres"],
      }),
      NO_DECLARATIONS,
    );
    // `postgres` is the owner and is not a finding; the three network-reachable roles are.
    expect([...r.executableBy].sort()).toEqual(["anon", "authenticated", "service_role"]);
  });

  it("ignores a grant that is not EXECUTE", () => {
    const r = classify(raw({ security_definer: true, acl: ["anon=r/postgres"] }), NO_DECLARATIONS);
    expect(r.executableBy).toEqual([]);
    expect(isExposedDefiner(r)).toBe(false);
  });

  it("needs BOTH halves — neither is a finding alone", () => {
    // SECURITY DEFINER with no grant is how a trigger function reaches a table its caller
    // cannot. An EXECUTE grant on an INVOKER function runs as the caller. Only the pair means
    // a network-reachable client can run owner-privileged code.
    expect(isExposedDefiner(classify(raw({ security_definer: true }), NO_DECLARATIONS))).toBe(false);
    expect(
      isExposedDefiner(classify(raw({ security_definer: false, acl: ["anon=X/postgres"] }), NO_DECLARATIONS)),
    ).toBe(false);
  });

  it("never flags a trigger or an event trigger — only a callable function", () => {
    for (const kind of ["trigger", "event_trigger"] as const) {
      const r = classify(raw({ kind, security_definer: true, acl: ["anon=X/postgres"] }), NO_DECLARATIONS);
      expect(isExposedDefiner(r)).toBe(false);
    }
  });

  it("derives its role set from the same list the RLS audit uses", () => {
    // Two hardcoded role lists is how one of them ends up a member short.
    expect(EXECUTE_RISK_ROLES).toEqual(DATA_API_ROLES.filter((r) => r !== "PUBLIC").map((r) => r.toLowerCase()));
    expect(EXECUTE_RISK_ROLES).not.toContain("public");
  });
});

describe("declared or not", () => {
  it("matches a function against the function set and a trigger against the trigger set", () => {
    const declared = { functions: new Set(["_log_delete"]), triggers: new Set(["_t_log_del_workers"]) };
    expect(classify(raw({ name: "_log_delete" }), declared).declaredByAMigration).toBe(true);
    expect(classify(raw({ name: "rls_auto_enable" }), declared).declaredByAMigration).toBe(false);
    expect(
      classify(raw({ kind: "trigger", name: "_t_log_del_workers" }), declared).declaredByAMigration,
    ).toBe(true);
    // ...and NOT against the other set: a trigger sharing a function's name is still undeclared.
    expect(classify(raw({ kind: "trigger", name: "_log_delete" }), declared).declaredByAMigration).toBe(false);
  });
});

describe("the report", () => {
  const rows: RoutineRow[] = [
    { kind: "function", name: "rls_auto_enable", owner: "postgres", securityDefiner: true, executableBy: ["PUBLIC"], on: null, declaredByAMigration: false },
    { kind: "event_trigger", name: "ensure_rls", owner: "postgres", securityDefiner: true, executableBy: [], on: "ddl_command_end", declaredByAMigration: false },
    { kind: "function", name: "pgrst_ddl_watch", owner: "supabase_admin", securityDefiner: false, executableBy: [], on: null, declaredByAMigration: false },
  ];

  it("counts OUR undeclared routines, not the platform's", () => {
    // Supabase installs its own; reporting those as findings would bury the two that matter.
    const out = render(rows, null, []).join("\n");
    expect(out).toContain("owned by 'postgres' (OURS)  2");
    expect(out).toContain("...that no migration creates 2");
    expect(out).not.toMatch(/UNDECLARED[\s\S]*pgrst_ddl_watch/);
  });

  it("says what an undeclared routine costs — absence, silently", () => {
    expect(render(rows, null, []).join("\n")).toContain("absent on every fresh database");
  });

  it("labels the captured query text and the client IP for what they are", () => {
    const out = render(
      rows,
      { rows: 147, first_at: "a", last_at: "b", source_tables: 2, with_query_text: 147, with_client_addr: 147, longest_query_chars: 400, phone_e164_shaped: 0, ten_digit_run: 35, ten_digit_in_literal: 35, bare_indian_mobile_literal: 0, email_shaped: 0 },
      [{ table_name: "workers", n: 104 }],
    ).join("\n");
    expect(out).toContain("current_query(), verbatim");
    expect(out).toContain("personal data under DPDP");
    expect(out).toContain("counts, never values");
  });

  it("points at the register rather than proposing a change", () => {
    // The tool investigates. Nothing is removed or altered before the page has an answer.
    const out = render(rows, null, []).join("\n");
    expect(out).toContain("gap-db-undeclared-routines.md");
    expect(out).toContain("nothing should be changed");
  });
});

describe("--strict — the verdict that makes the 0085 REVOKE verifiable", () => {
  const fn = (o: Partial<RoutineRow> = {}): RoutineRow => ({
    kind: "function",
    name: "f",
    owner: "postgres",
    securityDefiner: true,
    executableBy: ["anon"],
    on: null,
    declaredByAMigration: false,
    ...o,
  });

  it("FAILS while a function we own is SECURITY DEFINER and Data-API executable", () => {
    // The production state on 2026-08-20, and the state 0085 exists to change.
    const problems = strictProblems([
      fn({ name: "_log_delete", executableBy: ["PUBLIC", "anon", "authenticated", "service_role"] }),
      fn({ name: "is_active_payer_member", executableBy: ["anon"] }),
      fn({ name: "rls_auto_enable", executableBy: ["service_role"] }),
    ]);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toBe(
      "_log_delete(): SECURITY DEFINER, owned by postgres, " +
        "EXECUTE held by PUBLIC, anon, authenticated, service_role",
    );
    // Sorted, so two runs against the same database produce the same text and a diff of the
    // report before and after 0085 shows only what actually changed.
    expect([...problems].sort()).toEqual(problems);
  });

  it("PASSES once the grants are gone — the same rows, only the ACL changed", () => {
    // This is the after-state 0085 produces, and the only evidence that the REVOKE took.
    expect(
      strictProblems([
        fn({ name: "_log_delete", executableBy: [] }),
        fn({ name: "is_active_payer_member", executableBy: [] }),
        fn({ name: "rls_auto_enable", executableBy: [] }),
      ]),
    ).toEqual([]);
  });

  it("is NOT scoped to the three known names — a fourth exposed function fails it too", () => {
    // ALTER DEFAULT PRIVILEGES ... ON FUNCTIONS GRANT EXECUTE is still live for `postgres` in
    // `public`, so the next CREATE FUNCTION arrives with the same grant. A check that knew only
    // the three names would pass the day a fourth appears — which is this finding, repeated.
    const problems = strictProblems([fn({ name: "some_new_helper", executableBy: ["authenticated"] })]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("some_new_helper()");
  });

  it("ignores the platform's own definers — they are supabase_admin's, not ours", () => {
    expect(strictProblems([fn({ name: "pgrst_ddl_watch", owner: "supabase_admin" })])).toEqual([]);
  });

  it("needs both halves, exactly like isExposedDefiner", () => {
    expect(strictProblems([fn({ securityDefiner: false })])).toEqual([]);
    expect(strictProblems([fn({ executableBy: [] })])).toEqual([]);
  });

  it("does not mutate the row's readonly executableBy while sorting it", () => {
    const frozen = Object.freeze(["service_role", "anon"]) as readonly string[];
    const row = fn({ executableBy: frozen });
    expect(() => strictProblems([row])).not.toThrow();
    expect(row.executableBy).toEqual(["service_role", "anon"]);
  });
});
