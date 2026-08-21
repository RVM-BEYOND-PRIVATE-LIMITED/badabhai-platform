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

/**
 * The `concurrency:` mapping of ONE job, as written.
 *
 * A separate parser from {@link topLevelConcurrency} on purpose: that one is anchored to column
 * 0 so a job-level block can never be mistaken for the workflow-level one. The consequence was
 * that it is also blind to the job-level block — #1147 added one to `deploy-lightsail` and every
 * assertion in this file stayed green, so the serialisation it shipped was pinned by nothing and
 * could have been deleted without a word.
 */
export function jobConcurrency(yaml: string, job: string): string | null {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l === `  ${job}:`);
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    // The next top-level job ends this one's body.
    if (/^ {2}[A-Za-z0-9_-]+:$/.test(line)) return null;
    if (line !== "    concurrency:") continue;
    const out = [line];
    for (let j = i + 1; j < lines.length; j += 1) {
      const l = lines[j] as string;
      if (!/^ {6}\S/.test(l) && l.trim() !== "") break;
      out.push(l);
    }
    return out.join("\n");
  }
  return null;
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
    // An EXACT line, not `toContain`. `toContain` would happily accept
    // `group: ci-${{ github.ref }}-${{ github.run_id }}`, which gives every main run its OWN
    // group — so no run is ever pending, nothing is ever cancelled, and every main run goes
    // CONCURRENT. That reads like a fix for the pending-run residual and is precisely the
    // racing-deploys failure the job-level block below exists to prevent.
    const lines = (topLevelConcurrency(CI) as string).split("\n").map((l) => l.trim());
    expect(lines).toContain("group: ci-${{ github.ref }}");
  });

  it("names the deploy job the cancellation was killing, so a rename cannot orphan this guard", () => {
    // If `deploy-lightsail` is ever renamed or removed, the reasoning above stops applying and
    // whoever does it should be forced to read this file.
    expect(CI).toContain("  deploy-lightsail:");
  });
});

describe("deploy-lightsail serialises against itself — #1147, which nothing else pins", () => {
  /**
   * Two different jobs, two different failures, and both settings are needed.
   *
   *   workflow level (#1117) — a main run must not be CANCELLED by the next merge, so the tip
   *                            of main always reaches the deploy job.
   *   job level      (#1147) — two deploys must not run at once against ONE box, which is a
   *                            worse failure than a deploy waiting.
   *
   * Deleting either one leaves the other looking correct.
   */
  it("declares a job-level concurrency group on deploy-lightsail", () => {
    expect(jobConcurrency(CI, "deploy-lightsail")).not.toBeNull();
  });

  it("never cancels a deploy in progress — a half-applied deploy is the thing to avoid", () => {
    const block = jobConcurrency(CI, "deploy-lightsail") as string;
    expect(block).toMatch(/cancel-in-progress:\s*false\b/);
    // The complement: in a YAML mapping the LAST duplicate key wins, so a stray `true` appended
    // below would be indistinguishable from the bug while a `toMatch` alone stayed green.
    expect(block).not.toMatch(/cancel-in-progress:\s*true\b/);
  });

  it("uses a FIXED group, so every deploy contends with every other deploy", () => {
    // A group interpolating `github.sha` or `github.run_id` would give each deploy its own
    // group and serialise nothing at all — the same shape of mistake as the workflow-level one
    // above, and just as invisible.
    const block = jobConcurrency(CI, "deploy-lightsail") as string;
    expect(block).toContain("group: deploy-lightsail-main");
    expect(block).not.toContain("${{");
  });

  it("the two blocks are distinct — the parsers must not read each other's", () => {
    // Non-vacuity for the split. If `jobConcurrency` fell through to the workflow-level block,
    // every assertion above would pass while testing the wrong thing entirely.
    const job = jobConcurrency(CI, "deploy-lightsail") as string;
    const top = topLevelConcurrency(CI) as string;
    expect(job).not.toBe(top);
    expect(top).toContain("ci-${{ github.ref }}");
    expect(job).not.toContain("ci-${{ github.ref }}");
    // And the workflow-level parser must stay blind to the job-level one, which is what its
    // column-0 anchor buys.
    expect(top).not.toContain("deploy-lightsail-main");
  });

  it("the job-level parser returns null for a job that has no concurrency block", () => {
    // Otherwise "not.toBeNull()" above proves nothing about `deploy-lightsail` specifically.
    expect(jobConcurrency(CI, "ci-required")).toBeNull();
    expect(jobConcurrency(CI, "no-such-job")).toBeNull();
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
