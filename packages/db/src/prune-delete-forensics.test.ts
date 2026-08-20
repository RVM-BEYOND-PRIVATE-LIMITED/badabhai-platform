/**
 * The bounded retention policy — the parts that must be right before it ever deletes a row.
 *
 * The runner's SQL needs a database; its POLICY does not, and the policy is where a retention
 * sweep goes wrong. Two failure modes are worth more than the rest: a window short enough to be
 * disposal rather than retention, and a report that cannot tell "nothing to do" from "did
 * nothing". Both are pinned here.
 */
import { describe, expect, it } from "vitest";

import {
  MIN_RETENTION_DAYS,
  SCRIPT,
  render,
  resolveRetentionDays,
  type PruneCounts,
} from "./prune-delete-forensics";
import { DELETE_FORENSICS_RETENTION_DAYS } from "./schema/delete-forensics";

const counts = (o: Partial<PruneCounts> = {}): PruneCounts => ({
  total: 147,
  expired: 0,
  oldest: "2026-08-13 10:44:29+00",
  newestExpired: null,
  ...o,
});

describe("the retention window", () => {
  it("defaults to the one constant the schema declares", () => {
    // ONE definition, imported by the runner, the audit and these tests. Two copies of a
    // retention period is how the report and the sweep end up disagreeing about what expired.
    expect(resolveRetentionDays([])).toBe(DELETE_FORENSICS_RETENTION_DAYS);
    expect(DELETE_FORENSICS_RETENTION_DAYS).toBe(90);
  });

  it("accepts an explicit window at or above the floor", () => {
    expect(resolveRetentionDays(["--retention-days=180"])).toBe(180);
    expect(resolveRetentionDays([`--retention-days=${MIN_RETENTION_DAYS}`])).toBe(MIN_RETENTION_DAYS);
  });

  it("REFUSES a window below the floor, and says why rather than clamping", () => {
    // Clamping silently would be worse: the operator asked for 1 day, got 30, and the report
    // would not obviously say so. A refusal makes the disagreement visible.
    for (const n of [0, 1, 7, MIN_RETENTION_DAYS - 1]) {
      expect(() => resolveRetentionDays([`--retention-days=${n}`])).toThrow(/floor/);
    }
    // `0` is the one that matters: it means "delete the whole table", which is not retention.
    expect(() => resolveRetentionDays(["--retention-days=0"])).toThrow(/disposal, not retention/);
  });

  it("REFUSES a non-integer rather than falling back to the default", () => {
    // A typo that silently reverted to 90 days would be a sweep the operator did not ask for —
    // and `parseInt` is worse than that: it reads "90x" as 90 and "9.5" as 9, so a fat-fingered
    // window is ACCEPTED at a tenth of the intended length. Whole-string, or refuse.
    for (const bad of ["abc", "", "9.5", "90x", " 90", "-90", "1e3"]) {
      expect(() => resolveRetentionDays([`--retention-days=${bad}`]), bad).toThrow(/whole number|floor/);
    }
    expect(() => resolveRetentionDays(["--retention-days=90x"])).toThrow(/whole number/);
  });

  it("names itself for OPS_ALLOW_PRODUCTION", () => {
    expect(SCRIPT).toBe("prune:delete-forensics");
  });
});

describe("the report", () => {
  it("PLAN is the default and says nothing was deleted", () => {
    const out = render(counts({ expired: 12, newestExpired: "x" }), 90, false, 0).join("\n");
    expect(out).toContain("PLAN");
    expect(out).toContain("nothing was deleted");
    expect(out).toContain("Re-run with --apply to remove 12 row(s)");
    expect(out).toContain("two ops-guard signals");
  });

  it("distinguishes NOTHING TO DO from DID NOTHING — the state it launches in", () => {
    // Measured on production 2026-08-21: 147 rows, oldest 2026-08-13, 0 over 90 days. A report
    // that said only "deleted 0" would read identically to a broken sweep.
    const out = render(counts({ expired: 0 }), 90, false, 0).join("\n");
    expect(out).toContain("Nothing to do");
    expect(out).toContain("no row has reached the window yet");
    expect(out).not.toContain("Re-run with --apply");
  });

  it("APPLY reports what it actually removed, next to what it found", () => {
    const out = render(counts({ total: 200, expired: 12, newestExpired: "x" }), 90, true, 12).join("\n");
    expect(out).toContain("APPLY");
    expect(out).toContain("DELETED 12 row(s)");
    // The before-count survives into the report; a DELETE ... RETURNING alone cannot say
    // "out of how many".
    expect(out).toContain("200");
  });

  it("always states the window it ran with", () => {
    expect(render(counts(), 90, false, 0)[0]).toContain("retention window 90 days");
    expect(render(counts(), 180, false, 0)[0]).toContain("retention window 180 days");
  });

  it("handles an empty table without pretending it has an oldest row", () => {
    const out = render(counts({ total: 0, expired: 0, oldest: null }), 90, false, 0).join("\n");
    expect(out).toContain("(table is empty)");
  });

  it("prints no row content — the table has no PII columns left, and this keeps it that way", () => {
    // `0086` dropped `query` and `client_addr`, so there is nothing here to leak. The report is
    // counts and two timestamps, and that is worth pinning before someone adds "which rows".
    const out = render(counts({ expired: 5, newestExpired: "2026-01-01" }), 90, true, 5).join("\n");
    expect(out).not.toMatch(/\bquery\b/);
    expect(out).not.toMatch(/client_addr/);
    expect(out).not.toMatch(/worker_id/);
  });
});
