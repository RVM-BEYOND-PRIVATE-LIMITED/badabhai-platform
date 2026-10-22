import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";

import { OtherAnswerPolishService } from "./other-answer-polish.service";

const CTX = { correlationId: "c1", requestId: "r1" };

function makeService(overrides: {
  polishWorkHistory?: ReturnType<typeof vi.fn>;
  savePolishedOtherAnswer?: ReturnType<typeof vi.fn>;
} = {}) {
  const ai = {
    polishWorkHistory:
      overrides.polishWorkHistory ?? vi.fn(async () => ({ work_done: "Batliboi lathe (rewired)" })),
  };
  const repo = {
    savePolishedOtherAnswer: overrides.savePolishedOtherAnswer ?? vi.fn(async () => true),
  };
  const aiCost = { record: vi.fn(async () => undefined) };
  const service = new OtherAnswerPolishService(ai as never, repo as never, aiCost as never);
  return { service, ai, repo, aiCost };
}

describe("OtherAnswerPolishService.review — fail-closed contract", () => {
  it("never calls the model, and returns null, when the kill switch is off", async () => {
    const { service, ai } = makeService();
    const result = await service.review(
      "worker-1",
      "qp_cnc_turning",
      "turning_machine",
      "ek purana Batliboi lathe",
      "turning_machine",
      CTX,
      { WORK_HISTORY_POLISH_ENABLED: false },
      { polished: null, declined: false },
    );
    expect(result).toBeNull();
    expect(ai.polishWorkHistory).not.toHaveBeenCalled();
  });

  it("prints the reviewed rewrite, never the raw typed text, on success", async () => {
    const { service } = makeService();
    const result = await service.review(
      "worker-1",
      "qp_cnc_turning",
      "turning_machine",
      "ek purana Batliboi lathe",
      "turning_machine",
      CTX,
      { WORK_HISTORY_POLISH_ENABLED: true },
      { polished: null, declined: false },
    );
    expect(result).toBe("Batliboi lathe (rewired)");
    expect(result).not.toContain("ek purana");
  });

  it("omits the reply (never prints raw) when the model returns nothing — irrelevant, per the ruling", async () => {
    const { service } = makeService({ polishWorkHistory: vi.fn(async () => ({ work_done: "" })) });
    const result = await service.review(
      "worker-1",
      "qp_cnc_turning",
      "turning_machine",
      "mujhe job chahiye",
      "turning_machine",
      CTX,
      { WORK_HISTORY_POLISH_ENABLED: true },
      { polished: null, declined: false },
    );
    expect(result).toBeNull();
  });

  it("omits the reply (never prints raw) when the AI service is unreachable", async () => {
    const { service } = makeService({ polishWorkHistory: vi.fn(async () => null) });
    const result = await service.review(
      "worker-1",
      "qp_cnc_turning",
      "turning_machine",
      "ek purana Batliboi lathe",
      "turning_machine",
      CTX,
      { WORK_HISTORY_POLISH_ENABLED: true },
      { polished: null, declined: false },
    );
    expect(result).toBeNull();
  });

  it("omits the reply and never throws when the call itself throws", async () => {
    const { service } = makeService({
      polishWorkHistory: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const result = await service.review(
      "worker-1",
      "qp_cnc_turning",
      "turning_machine",
      "ek purana Batliboi lathe",
      "turning_machine",
      CTX,
      { WORK_HISTORY_POLISH_ENABLED: true },
      { polished: null, declined: false },
    );
    expect(result).toBeNull();
  });

  it("a worker's refusal is not an absence — declined short-circuits before any model call", async () => {
    const { service, ai } = makeService();
    const result = await service.review(
      "worker-1",
      "qp_cnc_turning",
      "turning_machine",
      "ek purana Batliboi lathe",
      "turning_machine",
      CTX,
      { WORK_HISTORY_POLISH_ENABLED: true },
      { polished: null, declined: true },
    );
    expect(result).toBeNull();
    expect(ai.polishWorkHistory).not.toHaveBeenCalled();
  });

  it("an already-stored polish is returned without a second model call", async () => {
    const { service, ai } = makeService();
    const result = await service.review(
      "worker-1",
      "qp_cnc_turning",
      "turning_machine",
      "ek purana Batliboi lathe",
      "turning_machine",
      CTX,
      { WORK_HISTORY_POLISH_ENABLED: true },
      { polished: "Batliboi lathe", declined: false },
    );
    expect(result).toBe("Batliboi lathe");
    expect(ai.polishWorkHistory).not.toHaveBeenCalled();
  });

  it("audit fix F2A: OTHER_ANSWER_POLISH_DISABLED stops the call — no model, no spend, no write", async () => {
    const { service, ai, repo, aiCost } = makeService();
    const result = await service.review(
      "worker-1",
      "qp_cnc_turning",
      "turning_machine",
      "ek purana Batliboi lathe",
      "turning_machine",
      CTX,
      { WORK_HISTORY_POLISH_ENABLED: true, OTHER_ANSWER_POLISH_DISABLED: true },
      { polished: null, declined: false },
    );
    expect(result).toBeNull();
    expect(ai.polishWorkHistory).not.toHaveBeenCalled();
    expect(aiCost.record).not.toHaveBeenCalled();
    expect(repo.savePolishedOtherAnswer).not.toHaveBeenCalled();
  });

  it("audit fix F2A: the switch OFF (or absent) is today's behaviour — the review still runs", async () => {
    for (const config of [
      { WORK_HISTORY_POLISH_ENABLED: true, OTHER_ANSWER_POLISH_DISABLED: false },
      { WORK_HISTORY_POLISH_ENABLED: true },
    ]) {
      const { service, ai, repo } = makeService();
      const result = await service.review(
        "worker-1",
        "qp_cnc_turning",
        "turning_machine",
        "ek purana Batliboi lathe",
        "turning_machine",
        CTX,
        config,
        { polished: null, declined: false },
      );
      expect(result).toBe("Batliboi lathe (rewired)");
      expect(ai.polishWorkHistory).toHaveBeenCalledTimes(1);
      expect(repo.savePolishedOtherAnswer).toHaveBeenCalledTimes(1);
    }
  });

  it("a failed write-back does not cost the caller its already-computed rewrite", async () => {
    const { service } = makeService({
      savePolishedOtherAnswer: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    const result = await service.review(
      "worker-1",
      "qp_cnc_turning",
      "turning_machine",
      "ek purana Batliboi lathe",
      "turning_machine",
      CTX,
      { WORK_HISTORY_POLISH_ENABLED: true },
      { polished: null, declined: false },
    );
    expect(result).toBe("Batliboi lathe (rewired)");
  });
});
