/**
 * `scalar` — the one piece of the shared probe plumbing that had no test.
 *
 * `causeOf`, `allPassed`, `formatResults` and `RollbackSignal` are covered where they were
 * written, through `verify-unresolved-write.ts`'s re-exports; those tests move with the
 * behaviour, not with the file, so they are deliberately not duplicated here.
 *
 * `scalar` is worth its own: the failure it guards against is silent. With
 * `noUncheckedIndexedAccess`, `rows[0]` on an empty result is `undefined`, and a probe that
 * destructures it compares `undefined !== undefined`… which is false, so a count query that
 * returned NO ROW AT ALL reads as "the count did not change" — the probe passes by accident, on
 * evidence it never collected.
 */
import { describe, expect, it } from "vitest";

import { scalar } from "./probe-report";

describe("scalar", () => {
  it("returns the first row when there is one", () => {
    expect(scalar([{ n: 3 }], "the row count", "verify:x")).toEqual({ n: 3 });
  });

  it("throws on an empty result rather than yielding undefined", () => {
    expect(() => scalar([], "the row count", "verify:x")).toThrow(/returned no row/);
  });

  it("names the script and what was being counted, so the throw is diagnosable", () => {
    expect(() => scalar([], "the pre-probe row count", "verify:rls-lock")).toThrow(
      "[verify:rls-lock] the pre-probe row count returned no row",
    );
  });

  it("ignores rows beyond the first — a scalar query that returns more is still answerable", () => {
    expect(scalar([{ n: 1 }, { n: 2 }], "x", "verify:x")).toEqual({ n: 1 });
  });
});
