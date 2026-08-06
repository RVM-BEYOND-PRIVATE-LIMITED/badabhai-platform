import { describe, expect, it } from "vitest";

import { catalogEmptyFailure } from "./verify-job-domains";

/**
 * Regression test for the "catalog is empty" deploy gate (Phase 1 acceptance criterion:
 * "`db:verify:domains` FAILs on an empty table (regression test for the inert check)").
 *
 * THE BUG THIS EXISTS FOR. The empty-catalog condition was once pushed through the
 * `checks` array. Every entry there counts BAD ROWS and the reporting loop treats
 * `count === 0` as PASS, so "0 domains" printed `PASS  catalog is empty` and exited 0 —
 * and since an unseeded table yields 0 for every other check too, the gate then announced
 * "all structural checks passed" against a database with no catalog at all. The one
 * failure the gate exists to catch inverted into a green run.
 *
 * SCOPE, STATED PLAINLY. This pins the DECISION, not the process exit code. Asserting the
 * real exit would mean running `tsx src/verify-job-domains.ts` against a database whose
 * `job_domain` table is empty, and `packages/db` has no live-database harness — the
 * `RUN_DB_TESTS` suites all live in `apps/api`, and truncating `job_domain` in a shared CI
 * database to create the condition would be destructive to every other suite sharing it.
 * The end-to-end behaviour is verified by hand on a throwaway database instead (create →
 * `db:migrate` → `db:verify:domains` → exit 1), and the CI gap is logged in the PR: nothing
 * in `.github/workflows/` invokes `db:verify:domains` at all today, despite the file
 * calling itself the DEPLOY GATE.
 */
describe("catalogEmptyFailure — the empty-catalog deploy gate", () => {
  it("reports a failure when the catalog has no rows", () => {
    const failure = catalogEmptyFailure(0);
    expect(failure).not.toBeNull();
    // The message has to tell an operator what to actually do; a bare "FAIL" on a fresh
    // database sends them reading source.
    expect(failure).toContain("catalog is empty");
    expect(failure).toContain("db:seed:domains --apply");
  });

  it("reports NOTHING for any non-empty catalog", () => {
    // The inverted-convention bug made zero mean PASS. Pin the other direction too, so a
    // future edit cannot make every catalog size "fail" and be papered over by disabling
    // the gate.
    for (const n of [1, 2, 436, 3885, 4071, 100_000]) {
      expect(catalogEmptyFailure(n), `${n} domains must not fail`).toBeNull();
    }
  });

  it("treats zero as the ONLY failing value — the finding IS the zero", () => {
    // This is the whole inversion in one assertion: `count === 0` means PASS everywhere
    // else in this file, and means FAIL here.
    expect(catalogEmptyFailure(0)).not.toBeNull();
    expect(catalogEmptyFailure(1)).toBeNull();
  });
});
