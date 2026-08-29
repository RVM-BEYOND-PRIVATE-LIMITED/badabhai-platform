/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * THE LOCAL LINT COMMAND MUST BE THE CI LINT GATE (R15 §6.3).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * THE INCIDENT. `npx oxlint <changed paths>` was run before pushing #1308, came back clean, and
 * CI failed on `@typescript-eslint/no-unused-vars` — an ERROR, on a line oxlint does not check.
 * The repo has two linters and only one of them is the gate: `pnpm lint` is `eslint .`, and
 * `lint:oxlint` is a payer-web-only supplementary pass over `apps/payer-web/src`. Reaching for
 * the fast one and reading its silence as the gate's silence cost a red CI and a second push.
 *
 * WHY A TEST RATHER THAN A NOTE. "Remember to run eslint" is the kind of instruction that works
 * until the day CI grows a third lint step, and then the note is quietly wrong and still
 * reassuring. This asserts the two are the same set: every `run:` line in the Node job that
 * invokes a lint script must be reachable from `pnpm lint:ci`, and `lint:ci` must not claim a
 * script that CI does not run. Add a lint step to `ci.yml` without adding it here and this goes
 * red, naming the step.
 *
 * IT DOES NOT RUN THE LINTERS. That is `pnpm lint:ci`'s job and it takes minutes; this asserts
 * the WIRING, which is the part that was wrong.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import { test } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const CI = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

/** Root scripts whose command actually invokes a linter binary. */
function lintScripts() {
  return Object.entries(PKG.scripts)
    .filter(([name, cmd]) => /(^|\s)(eslint|oxlint)(\s|$)/.test(cmd) && name !== "lint:fix")
    .map(([name]) => name)
    .sort();
}

/** `pnpm <script>` invocations that appear as a CI `run:` step. */
function ciLintSteps() {
  const found = new Set();
  for (const m of CI.matchAll(/run:\s*pnpm\s+([\w:]+)/g)) {
    const script = m[1];
    const cmd = PKG.scripts[script];
    if (cmd && /(^|\s)(eslint|oxlint)(\s|$)/.test(cmd)) found.add(script);
  }
  return [...found].sort();
}

/** The scripts `lint:ci` chains, read out of its own command string. */
function chainedByLintCi() {
  const cmd = PKG.scripts["lint:ci"];
  assert.ok(cmd, "package.json has no `lint:ci` script — that IS the divergence this prevents");
  return [...cmd.matchAll(/pnpm\s+([\w:]+)/g)].map((m) => m[1]).sort();
}

test("the fixtures are real — this cannot pass vacuously", () => {
  // Every assertion below is a set comparison, and two empty sets are equal. If the regex ever
  // stops matching `ci.yml`'s shape, that is what this catches.
  assert.ok(CI.length > 10_000, "ci.yml did not load");
  assert.ok(
    lintScripts().length >= 2,
    `expected at least eslint+oxlint scripts, got ${lintScripts()}`,
  );
  assert.ok(ciLintSteps().length >= 2, `no lint steps found in ci.yml — the reader is broken`);
  assert.ok(PKG.scripts.lint.includes("eslint"), "`pnpm lint` is no longer eslint");
});

test("`pnpm lint:ci` runs exactly the lint steps CI runs", () => {
  assert.deepEqual(
    chainedByLintCi(),
    ciLintSteps(),
    "the local lint command and the CI lint gate have drifted — update `lint:ci` in package.json",
  );
});

test("oxlint is never the whole gate", () => {
  // The specific mistake, asserted directly: whatever `lint:ci` chains, eslint must be in it.
  const chained = chainedByLintCi()
    .map((s) => PKG.scripts[s])
    .join(" ");
  assert.match(chained, /eslint/, "`lint:ci` runs no eslint — oxlint alone is not the gate");
});
