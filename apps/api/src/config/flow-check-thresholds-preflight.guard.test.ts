import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { FLOW_CHECK_THRESHOLD_KEYS, parseFlowCheckThresholds } from "@badabhai/config";

/**
 * #2890 — THE DEPLOY PREFLIGHT FOR FLOW_CHECK_THRESHOLDS.
 *
 * The api parses the thresholds at boot and refuses a bad value (`parseFlowCheckThresholds`), and a
 * refused boot is an outage the deploy gate does not roll back. So `scripts/deploy/staging-deploy.sh`
 * checks the same grammar, keys and ranges before a container moves. This test keeps the two in
 * step: the script's key list equals the api's, and, where a bash is on PATH (always in CI), the
 * block run against each sample agrees with the api's parser, and never prints the value.
 *
 * The block is read from the script with comments stripped, so prose cannot satisfy it.
 */
const SCRIPT = readFileSync(join(__dirname, "../../../../scripts/deploy/staging-deploy.sh"), "utf8")
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

const HEAD = "FLOW_CHECK_THRESHOLD_KEYS=";
const TAIL = '\n_ft_value=""';
const start = SCRIPT.indexOf(HEAD);
const BLOCK =
  start < 0 || SCRIPT.indexOf(TAIL, start) < 0
    ? ""
    : SCRIPT.slice(start, SCRIPT.indexOf(TAIL, start) + TAIL.length);

const HAS_BASH = spawnSync("bash", ["-c", "exit 0"], { encoding: "utf8" }).status === 0;

function preflightRefuses(value: string | undefined): { bad: boolean; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.FLOW_CHECK_THRESHOLDS;
  if (value !== undefined) env.FLOW_CHECK_THRESHOLDS = value;
  const r = spawnSync("bash", ["-c", `set -eu\n_bad_flags=0\n${BLOCK}\necho "bad=$_bad_flags"`], {
    encoding: "utf8",
    env,
  });
  expect(r.status, r.stderr).toBe(0);
  return { bad: /bad=1/.test(r.stdout), out: r.stdout + r.stderr };
}

function apiRefuses(value: string | undefined): boolean {
  try {
    parseFlowCheckThresholds(value);
    return false;
  } catch {
    return true;
  }
}

describe("FLOW_CHECK_THRESHOLDS deploy preflight (#2890)", () => {
  it("is in the script, before the line that exits on a bad flag", () => {
    expect(BLOCK).not.toBe("");
    expect(SCRIPT.indexOf(HEAD)).toBeLessThan(SCRIPT.indexOf('if [ "$_bad_flags" -ne 0 ]'));
  });

  it("lists exactly the api's keys", () => {
    const listed = /FLOW_CHECK_THRESHOLD_KEYS=" ([a-z_ ]+) "/.exec(BLOCK)?.[1]?.split(" ") ?? [];
    expect([...listed].sort()).toEqual([...FLOW_CHECK_THRESHOLD_KEYS].sort());
  });

  const SAMPLES: readonly (string | undefined)[] = [
    undefined,
    "",
    "   ",
    "review_wait_hours=72",
    "review_wait_hours=72, zero_reach_max=5 ,untouched_max=off",
    "campus_report_max_age_hours=720,outbox_undelivered_max=100000,campus_missing_max=0",
    "review_wait_hours=0",
    "review_wait_hours=721",
    "review_wait_hours=off",
    "zero_reach_max=100001",
    "zero_reach_max=-1",
    "zero_reach_max=1.5",
    "zero_reach_max",
    "zero_reach_max=1,",
    ",zero_reach_max=1",
    "zero_reach_max=1,,untouched_max=2",
    "zero_reach_maximum=1",
    "Zero_reach_max=1",
    "zero_reach_max=1,zero_reach_max=2",
    "zero_reach_max=1;untouched_max=2",
    "zero reach_max=1",
  ];

  it.skipIf(!HAS_BASH).each(SAMPLES.map((s) => [JSON.stringify(s), s] as const))(
    "agrees with the api's parser on %s",
    (_label, value) => {
      expect(preflightRefuses(value).bad).toBe(apiRefuses(value));
    },
  );

  it.skipIf(!HAS_BASH)("never prints the value, only the variable's name", () => {
    const { bad, out } = preflightRefuses("review_wait_hours=9999,sentinel_key_xq=7");
    expect(bad).toBe(true);
    expect(out).toContain("FLOW_CHECK_THRESHOLDS");
    expect(out).not.toContain("sentinel_key_xq");
    expect(out).not.toContain("9999");
  });
});
