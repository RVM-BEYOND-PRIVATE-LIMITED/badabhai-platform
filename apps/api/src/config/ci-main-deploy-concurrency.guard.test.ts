/**
 * A `main` run is a DEPLOY, so it must never be cancelled by the next merge.
 *
 * WHY THIS IS A TEST AND NOT A COMMENT. The regression is a three-character edit — `true` in
 * place of the expression — and it is invisible in review because `cancel-in-progress: true`
 * is the *correct* and far more common setting for every other workflow in this repo. Four of
 * the five carry it deliberately. Only `ci.yml` deploys, and only `ci.yml` must not.
 *
 * The failure it caused is worse than a red build, because there is no red build:
 *
 *     measured 2026-08-20, last 59 settled runs on main:  39 cancelled / 20 success  (66%)
 *
 * `deploy-lightsail` is the last job in the workflow, so it is reliably the one still pending
 * when the next merge lands and kills the run. That usually self-heals — the next successful
 * run deploys a descendant commit — which is precisely why it went unnoticed: main was
 * *usually* live, by luck rather than by pipeline. It stops self-healing when the cancelled
 * run is the LAST one, and then main is merged, production is not running it, and nothing
 * anywhere is red.
 *
 * WHAT IS AND IS NOT ASSERTED. These tests pin the configuration, not GitHub's scheduler. The
 * expression does not promise that every main run completes — GitHub still cancels a
 * previously-PENDING run when a newer one joins the group. It promises the thing that was
 * broken: the newest run in the group survives, so the tip of `main` always reaches
 * `deploy-lightsail`.
 *
 * Refs #1041, #1021, #1019, #1017.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..", "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");
const CI = readFileSync(join(WORKFLOWS, "ci.yml"), "utf8");

/**
 * The top-level `concurrency:` mapping of a workflow, as written.
 *
 * Anchored to column 0 so a job-level `concurrency:` (indented two spaces) can never be
 * mistaken for the workflow-level one. Returns null when the workflow declares none.
 */
export function topLevelConcurrency(yaml: string): string | null {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l === "concurrency:");
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    // The next top-level key ends the block. Comments and indented entries do not.
    if (/^[A-Za-z0-9_-]+:/.test(lines[i] as string)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("ci.yml — a main run is a deploy and must not be cancelled by the next merge", () => {
  it("declares a top-level concurrency block at all", () => {
    // Deleting the block entirely would remove the cancellation AND the serialisation, letting
    // two deploys race onto one box — a worse failure than the one this guard exists for. So
    // absence is a failure here, not a pass by omission.
    expect(topLevelConcurrency(CI)).not.toBeNull();
  });

  it("makes cancel-in-progress conditional on the ref, never a bare true", () => {
    const block = topLevelConcurrency(CI) as string;
    expect(block).toContain("cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}");
    // The complement. `toContain` alone would still pass if a stray `cancel-in-progress: true`
    // were added below the expression — and in a YAML mapping the LAST duplicate key wins, so
    // that state would be indistinguishable from the bug while this file stayed green.
    expect(block).not.toMatch(/cancel-in-progress:\s*true\b/);
  });

  it("still groups by ref, so PR branches keep superseding themselves", () => {
    // The fix must not be implemented by widening the group (e.g. per-sha), which would stop
    // main runs cancelling each other by letting them all run CONCURRENTLY — reintroducing the
    // racing-deploys failure this block prevents.
    expect(topLevelConcurrency(CI) as string).toContain("group: ci-${{ github.ref }}");
  });

  it("names the deploy job the cancellation was killing, so a rename cannot orphan this guard", () => {
    // If `deploy-lightsail` is ever renamed or removed, the reasoning above stops applying and
    // whoever does it should be forced to read this file.
    expect(CI).toContain("  deploy-lightsail:");
  });
});

describe("the rest of the workflows keep cancelling — this is a deploy exemption, not a policy change", () => {
  /**
   * Every workflow that is NOT the deploy path. Each is supersedable by design: a newer commit
   * makes an older analysis irrelevant, and finishing it costs minutes for an answer nobody
   * reads. Listing them explicitly is the point — it records that `ci.yml` is the exception.
   */
  const SUPERSEDABLE = ["secret-parity-check.yml", "security-scan.yml", "supabase-checks.yml"];

  it.each(SUPERSEDABLE)("%s still cancels in progress", (file) => {
    const block = topLevelConcurrency(readFileSync(join(WORKFLOWS, file), "utf8"));
    expect(block, `${file} has no top-level concurrency block`).not.toBeNull();
    expect(block as string).toMatch(/cancel-in-progress:\s*true\b/);
  });

  it("staging-cd.yml — the OTHER deploy workflow — already refuses to cancel", () => {
    // The precedent this fix follows rather than invents. A deploy workflow in this repo
    // already pins `false`; ci.yml is the one that deploys to the box and did not.
    const block = topLevelConcurrency(readFileSync(join(WORKFLOWS, "staging-cd.yml"), "utf8"));
    expect(block as string).toMatch(/cancel-in-progress:\s*false\b/);
  });
});

describe("the parser itself — a reader that finds nothing would pass every assertion above", () => {
  it("does not mistake an indented job-level concurrency for the workflow-level one", () => {
    const yaml = ["name: X", "jobs:", "  a:", "    concurrency:", "      group: g", "    steps: []"].join("\n");
    expect(topLevelConcurrency(yaml)).toBeNull();
  });

  it("stops at the next top-level key rather than swallowing the rest of the file", () => {
    const yaml = ["concurrency:", "  group: g", "  cancel-in-progress: false", "jobs:", "  a:"].join("\n");
    expect(topLevelConcurrency(yaml)).toBe("concurrency:\n  group: g\n  cancel-in-progress: false");
  });

  it("keeps comment lines inside the block, so a commented-out setting is still visible to it", () => {
    const yaml = ["concurrency:", "  # why", "  group: g", "jobs:"].join("\n");
    expect(topLevelConcurrency(yaml)).toContain("# why");
  });

  it("FAILS on the exact regression, proving the assertions are not vacuous", () => {
    // The bug, reproduced in memory: this is what ci.yml said until #1041.
    const regressed = ["concurrency:", "  group: ci-${{ github.ref }}", "  cancel-in-progress: true", "jobs:"].join("\n");
    const block = topLevelConcurrency(regressed) as string;
    expect(block).toMatch(/cancel-in-progress:\s*true\b/);
    expect(block).not.toContain("cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}");
  });
});
