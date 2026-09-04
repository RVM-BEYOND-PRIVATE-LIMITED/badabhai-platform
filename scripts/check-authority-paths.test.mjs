/**
 * Self-test for `scripts/check-authority-paths.mjs`.
 *
 * The gate's job is to fail when the rules file names a document nobody can open. So the tests
 * that matter are the ones that make it go RED — a gate that only ever gets asked "does the
 * good case pass?" is indistinguishable from `exit 0`.
 *
 * The load-bearing case is `the bare document name … is caught`. It is a regression test for a
 * MEASURED miss: the first draft of the gate, run against the BUILD_RULES.md that shipped on
 * `main` before 2026-09-04, caught source-of-truth #1 and was blind to #2 — because #2 was
 * written without a `.md`. Both of those documents were missing from the repository. Catching
 * one of two is not a gate.
 *
 * Run: node --test scripts/check-authority-paths.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { check } from "./check-authority-paths.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const why = (r, name) => r.problems.find((p) => p.rel === name)?.why ?? "";

test("the real BUILD_RULES.md names only paths that resolve", () => {
  const text = readFileSync(join(REPO_ROOT, "docs/agent/BUILD_RULES.md"), "utf8");
  const r = check(text);
  assert.deepEqual(
    r.problems,
    [],
    `unresolved paths in BUILD_RULES.md:\n${r.problems.map((p) => `  :${p.line} ${p.rel} — ${p.why}`).join("\n")}`,
  );
});

test("a path that does not exist is caught, with its line number", () => {
  const r = check("read docs/decisions/9999-not-a-real-adr.md before starting");
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].rel, "docs/decisions/9999-not-a-real-adr.md");
  assert.equal(r.problems[0].line, 1);
  assert.match(r.problems[0].why, /no such file/);
});

test("THE REGRESSION — a bare document name with no directory and no extension is caught", () => {
  // Verbatim source-of-truth #2 from the BUILD_RULES.md that shipped on `main` until 2026-09-04.
  // The path rules alone do not see this: no slash, no extension, nothing to stat.
  const r = check("SOURCE OF TRUTH:\n  2. BadaBhai_MASTER_CONTEXT_2026-07-23\n");
  assert.equal(r.problems.length, 1, "the bare document name must be reported");
  assert.equal(r.problems[0].rel, "BadaBhai_MASTER_CONTEXT_2026-07-23");
  assert.equal(r.problems[0].line, 2);
  assert.match(r.problems[0].why, /no directory and no extension/);
});

test("both entries of the real historical failure are caught together", () => {
  const asShipped = [
    "SOURCE OF TRUTH, in order of authority:",
    "  1. BadaBhai_MVP_Matching_and_Posting_Execution_Spec_2026-09-01.md",
    "  2. BadaBhai_MASTER_CONTEXT_2026-07-23",
    "  3. The code at the HEAD commit given to you",
  ].join("\n");
  const named = check(asShipped).problems.map((p) => p.rel).sort();
  assert.deepEqual(named, [
    "BadaBhai_MASTER_CONTEXT_2026-07-23",
    "BadaBhai_MVP_Matching_and_Posting_Execution_Spec_2026-09-01.md",
  ]);
});

test("VACUITY — a rules file naming no paths reports a count of zero, never a silent pass", () => {
  // The caller fails the run on `count < MIN_PATHS`. What is asserted here is that a text with
  // nothing to check does NOT come back as "no problems found" over a real count.
  const r = check("Think before coding. Ask first. Do not assume business logic.");
  assert.equal(r.count, 0);
  assert.deepEqual(r.problems, []);
});

test("a glob that matches no file is caught; one that matches is not", () => {
  assert.equal(check("see docs/decisions/*.md").problems.length, 0);
  // `.sql` is a recognised extension, so the token IS extracted — it just matches no file in
  // that directory. (An unrecognised extension would not be extracted at all, which is a
  // different outcome and would make this assertion pass for the wrong reason.)
  assert.match(why(check("see docs/decisions/*.sql"), "docs/decisions/*.sql"), /glob matches no file/);
});

test("WHAT IT MUST PERMIT — a document name inside a real path is not flagged", () => {
  // The bare-name rule keys on a shape that every reference document in docs/reference/ also
  // has. If it fired on the full path too, the gate would go red on the very commit that fixed
  // the problem, and the fix would be to delete the rule.
  const r = check(
    "docs/reference/BadaBhai_MASTER_CONTEXT_2026-07-23.md\n" +
      "docs/decisions/RVM_TAXONOMY_WORKSHEET_2026-09.md\n" +
      "docs/reference/BadaBhai_Role_Taxonomy_Master_2026-08-09.md\n",
  );
  assert.deepEqual(r.problems, [], "a full repo-relative path must never be reported as bare");
  // 5, not 3: the three files plus the two directories `docs/reference/` and `docs/decisions/`,
  // which the directory rule extracts and stats in their own right.
  assert.equal(r.count, 5);
});

test("WHAT IT MUST PERMIT — prose, versions and the weight ledger are not paths", () => {
  const r = check(
    "Weights 35/20/15/15/10/5 are retired. See :7, :17 and E1-E18.\n" +
      "engine_version v1.0, tier_floor_months 36, applicant_quota off.\n",
  );
  assert.deepEqual(r.problems, [], "ordinary prose must not be read as a path");
});

test("WHAT IT MUST PERMIT — identifiers share the shape of a document name and are not flagged", () => {
  // Caught by this suite, not by review: `tier_floor_months` has the same underscore shape as
  // `BadaBhai_MASTER_CONTEXT_2026-07-23`, and the first draft reported it. Had it shipped, the
  // gate would have gone red the first time a column name or an env var was written into the
  // rules file — on a line that was entirely correct.
  const identifiers = [
    "tier_floor_months",           // lower snake_case column
    "applicant_visibility_quota",  // lower snake_case, three segments
    "OTP_MAX_SENDS_PER_DAY",       // screaming snake env var
    "PACE_ENABLED_FOR_MVP",        // screaming snake feature flag
  ];
  for (const id of identifiers) {
    assert.deepEqual(check(`the knob ${id} is unchanged`).problems, [], `${id} must be permitted`);
  }
  // …while a document name in the same sentence still fails.
  assert.equal(check("read BadaBhai_MASTER_CONTEXT_2026-07-23 first").problems.length, 1);
  assert.equal(check("read BadaBhai_Engineering_Context first").problems.length, 1);
});

test("root-level files are resolved relative to the repository root", () => {
  assert.deepEqual(check("PARKED.md and CLAUDE.md").problems, []);
  assert.match(why(check("NOPE_FILE.md"), "NOPE_FILE.md"), /write the full path/);
});
