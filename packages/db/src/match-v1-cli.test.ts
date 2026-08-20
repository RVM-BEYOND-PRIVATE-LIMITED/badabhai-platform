/**
 * The Matching-V1 harness's retired production key.
 *
 * `MATCH_V1_PROD_CONFIRM=apply-matching-v1` used to be the second key for a production run of
 * any of the thirteen scripts that route through `parseCommonCli`. It keyed on `NODE_ENV`, which
 * labels the PROCESS while the blast radius is decided by `DATABASE_URL`, so it was replaced on
 * 2026-08-20 by `opsGuard`'s two signals.
 *
 * THE INTERESTING PROPERTY IS NOT THAT IT STOPPED WORKING. It is that it stops working LOUDLY,
 * and only when it would have mattered. An operator working from an older copy of
 * `docs/ops/matching-v1-migration-runbook.md` exports the old variable, runs `--apply`, and is
 * refused — for a reason that, without this, would look unrelated to the thing they just did.
 * Silently ignoring a retired security control is how somebody concludes the guard is broken
 * and starts looking for a way around it.
 */
import { describe, expect, it } from "vitest";

import { RETIRED_PROD_CONFIRM_ENV, retiredConfirmTokenProblem } from "./match-v1-cli";
import { PRODUCTION_WRITE_ENV, PRODUCTION_WRITE_FLAG } from "./ops-guard";

const SCRIPT = "backfill:worker-skills";
const OLD = { [RETIRED_PROD_CONFIRM_ENV]: "apply-matching-v1" };

describe("the retired MATCH_V1_PROD_CONFIRM key", () => {
  it("says nothing when it is not set — the ordinary case", () => {
    expect(retiredConfirmTokenProblem({}, ["--apply"], SCRIPT)).toBeNull();
  });

  it("says nothing on a DRY RUN, even when it is set", () => {
    // A stale export is harmless here: the run writes nothing, so there is nothing to warn
    // about, and shouting at every dry run is how a message stops being read.
    expect(retiredConfirmTokenProblem(OLD, [], SCRIPT)).toBeNull();
  });

  it("REFUSES an --apply that is relying on it, and names both replacements", () => {
    const problem = retiredConfirmTokenProblem(OLD, ["--apply"], SCRIPT);
    expect(problem).not.toBeNull();
    expect(problem).toContain(RETIRED_PROD_CONFIRM_ENV);
    expect(problem).toContain("no longer authorises anything");
    expect(problem).toContain(PRODUCTION_WRITE_FLAG);
    expect(problem).toContain(`${PRODUCTION_WRITE_ENV}=${SCRIPT}`);
    expect(problem).toContain("matching-v1-migration-runbook.md");
  });

  it("says nothing when the run is ALREADY properly authorised — then it is just stale env", () => {
    // Refusing here would block a legitimate, correctly-authorised production run because of a
    // leftover variable that is now inert. The message exists to redirect somebody who is
    // relying on the old key, not to punish an untidy shell.
    expect(
      retiredConfirmTokenProblem(
        { ...OLD, [PRODUCTION_WRITE_ENV]: SCRIPT },
        ["--apply", PRODUCTION_WRITE_FLAG],
        SCRIPT,
      ),
    ).toBeNull();
  });

  it("still refuses when the new env var names a DIFFERENT runner", () => {
    // Half-authorised is not authorised, and the old key must not close the gap.
    expect(
      retiredConfirmTokenProblem(
        { ...OLD, [PRODUCTION_WRITE_ENV]: "some-other-script" },
        ["--apply", PRODUCTION_WRITE_FLAG],
        SCRIPT,
      ),
    ).not.toBeNull();
  });

  it("fires on ANY value, not only the old token", () => {
    // Somebody who typed the variable name from memory and got the value wrong was still
    // trying to use the retired mechanism, and needs the same redirection.
    expect(
      retiredConfirmTokenProblem({ [RETIRED_PROD_CONFIRM_ENV]: "yes" }, ["--apply"], SCRIPT),
    ).not.toBeNull();
    expect(
      retiredConfirmTokenProblem({ [RETIRED_PROD_CONFIRM_ENV]: "" }, ["--apply"], SCRIPT),
    ).not.toBeNull();
  });
});
