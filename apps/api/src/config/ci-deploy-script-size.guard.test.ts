/**
 * #994 — NO BLOCK SCALAR IN ci.yml MAY APPROACH GITHUB'S ~21 KB STEP-INPUT CEILING.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT — and why it earns a file of its own.
 *
 * GitHub Actions caps a single step input at roughly 21 KB. Crossing it fails in the worst
 * possible way: not a red X on your PR, and naming nothing. The ENTIRE workflow file becomes
 * unparseable, so GitHub creates **no run at all** — the required `ci-required` check never
 * appears, branch protection blocks the PR **permanently**, and the reason is stated nowhere
 * in the UI. The only trace is a 0-job run named after the file path: "This run likely failed
 * because of a workflow file issue". Every other check on the PR is green, so it reads as
 * mysteriously stuck rather than broken.
 *
 * The `deploy-lightsail` script reached 20,342 characters — 97% of the ceiling — purely by
 * being well commented, which is the house style everywhere in this repo and is not the thing
 * to fix. On 2026-08-19 two independent PRs (#1001, #1002) added to it, both became
 * unmergeable, and finding the cause took a bisect.
 *
 * MEASURED, NOT INFERRED. Padding that script to 24,252 chars reproduced the failure; padding
 * the same file by the same ~6 KB OUTSIDE any scalar — file sizes within 1 KB of each other —
 * did not. The breaking variable is the length of one step input, not the size of the file.
 *
 * The structural fix is that the deploy body now lives in scripts/deploy/staging-deploy.sh,
 * where it can grow without limit. THIS test stops the ceiling being re-approached by some
 * future inline block: it converts an invisible, permanently-blocking failure into a red test
 * that explains itself.
 *
 * Text-based on purpose (no YAML parser), matching the other compose/workflow guards in this
 * directory — the question is "how long is this literal block", which needs no semantics.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..", "..");
const CI_PATH = join(ROOT, ".github", "workflows", "ci.yml");
const CI = readFileSync(CI_PATH, "utf8");

/**
 * The empirical ceiling sits between 20,342 (known-good) and 21,000 (known-bad). 12,000 is a
 * deliberately conservative budget: well under the smallest known-bad value, while leaving any
 * single block far more room than it should need now that the long one is a file. A block that
 * legitimately wants more than this wants to be a script.
 */
const MAX_BLOCK_SCALAR_CHARS = 12_000;

/** Every `key: |`-style block scalar in the workflow, with its key, line and length. */
function blockScalars(yaml: string): Array<{ key: string; line: number; length: number }> {
  const lines = yaml.split("\n");
  const found: Array<{ key: string; line: number; length: number }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const header = /^(\s*)([A-Za-z_-]+):\s*[|>][+-]?\s*$/.exec(lines[i] ?? "");
    if (!header) continue;
    const indent = (header[1] ?? "").length;
    const key = header[2] ?? "";

    let length = 0;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j] ?? "";
      // A blank line stays inside the block; anything indented at or below the header ends it.
      if (line.trim() !== "" && line.search(/\S/) <= indent) break;
      length += line.length + 1;
    }
    found.push({ key, line: i + 1, length });
  }
  return found;
}

const SCALARS = blockScalars(CI);

describe("#994 — ci.yml stays clear of the GitHub Actions step-input ceiling", () => {
  it("finds the workflow's block scalars at all (the guard is not vacuous)", () => {
    // If the matcher silently stopped matching, every assertion below would pass forever.
    expect(SCALARS.length).toBeGreaterThan(5);
    expect(SCALARS.some((s) => s.key === "run")).toBe(true);
  });

  it("keeps every block scalar under the budget", () => {
    const over = SCALARS.filter((s) => s.length > MAX_BLOCK_SCALAR_CHARS).sort(
      (a, b) => b.length - a.length,
    );

    expect(
      over.map((s) => `${s.key}: at line ${s.line} = ${s.length} chars`),
      "A block in .github/workflows/ci.yml has grown past its budget. GitHub Actions caps a " +
        "step input at roughly 21 KB, and crossing it does NOT produce an error on your PR — " +
        "the whole workflow becomes unparseable, NO run is created, `ci-required` never " +
        "appears, and branch protection blocks the PR permanently with no stated reason. " +
        "Move the body into a script under scripts/deploy/ and call it, the way " +
        "deploy-lightsail calls scripts/deploy/staging-deploy.sh. Do NOT simply raise this " +
        "number: the ceiling is GitHub's, not ours.",
    ).toEqual([]);
  });

  it("keeps the deploy body in a script file rather than inline", () => {
    // The specific regression that blocked #1001 and #1002. Re-inlining it would pass the
    // budget above for a while, then march back into the ceiling.
    expect(CI).toContain("bash scripts/deploy/staging-deploy.sh");
    const deployBlock = SCALARS.find((s) => s.key === "script");
    expect(deployBlock, "the deploy ssh step no longer has a `script` block").toBeDefined();
    expect(
      deployBlock!.length,
      "the deploy script went back to being inline. It belongs in " +
        "scripts/deploy/staging-deploy.sh — see that file's header for why.",
    ).toBeLessThan(2_000);
  });

  it("bridges the runner-side context the extracted script cannot read on the box", () => {
    // GitHub context does not exist on the deploy box. If these stop being forwarded, the
    // image tag resolves to `sha-` and the deploy pulls a nonexistent image. The script
    // asserts them at runtime; this asserts the wiring that feeds them.
    const envsLine = /^\s+envs: .*$/m.exec(CI)?.[0] ?? "";
    for (const name of ["GH_SHA", "GH_ACTOR", "GH_REPOSITORY", "GHCR_TOKEN"]) {
      expect(CI, `${name} must be defined in the deploy step's env:`).toMatch(
        new RegExp(`^\\s+${name}: \\$\\{\\{`, "m"),
      );
      expect(
        envsLine,
        `${name} must ALSO be listed in the ssh action's envs:, or it is never forwarded`,
      ).toContain(name);
    }
  });

  it("pulls before running the script, so the box runs THIS commit's version", () => {
    const pull = CI.indexOf("git pull origin main");
    const run = CI.indexOf("bash scripts/deploy/staging-deploy.sh");
    expect(pull).toBeGreaterThan(-1);
    expect(
      pull,
      "the deploy must `git pull` BEFORE invoking the script, or the box executes the " +
        "PREVIOUS commit's deploy logic against this commit's images.",
    ).toBeLessThan(run);
  });
});
