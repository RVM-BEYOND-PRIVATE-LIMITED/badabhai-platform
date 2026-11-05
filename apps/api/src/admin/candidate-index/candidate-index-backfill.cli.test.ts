import { describe, expect, it } from "vitest";
import { parseCandidateIndexBackfillArgs } from "./candidate-index-backfill.cli";

describe("parseCandidateIndexBackfillArgs (strict argv, never a guess)", () => {
  it("defaults to a dry-run backfill", () => {
    expect(parseCandidateIndexBackfillArgs([])).toEqual({
      apply: false,
      batchSize: 500,
      worker: null,
      drift: false,
      driftSample: 200,
    });
  });

  it("accepts a bounded batch, a worker uuid and drift mode", () => {
    expect(
      parseCandidateIndexBackfillArgs([
        "--apply",
        "--batch-size=100",
        "--worker=11111111-1111-4111-8111-111111111111",
        "--drift",
        "--drift-sample=50",
      ]),
    ).toEqual({
      apply: true,
      batchSize: 100,
      worker: "11111111-1111-4111-8111-111111111111",
      drift: true,
      driftSample: 50,
    });
  });

  it("rejects unknown flags, bad uuids and out-of-range batches", () => {
    expect(() => parseCandidateIndexBackfillArgs(["--nope"])).toThrow();
    expect(() => parseCandidateIndexBackfillArgs(["--worker=xyz"])).toThrow();
    expect(() => parseCandidateIndexBackfillArgs(["--batch-size=0"])).toThrow();
    expect(() => parseCandidateIndexBackfillArgs(["--batch-size=5001"])).toThrow();
    expect(() => parseCandidateIndexBackfillArgs(["--drift-sample=0"])).toThrow();
  });
});
