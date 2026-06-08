import { describe, it, expect } from "vitest";
import { scoreWorkerForJob, REACH_ENGINE_NOT_IMPLEMENTED } from "./index";

describe("reach-engine placeholder", () => {
  it("throws — not implemented in Phase 1", () => {
    expect(() => scoreWorkerForJob({ workerId: "w1", jobId: "j1" })).toThrow(
      REACH_ENGINE_NOT_IMPLEMENTED,
    );
  });
});
