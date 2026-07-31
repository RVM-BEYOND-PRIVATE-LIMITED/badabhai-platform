import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { Job } from "bullmq";
import { ReferralBonusProcessor } from "./referral-bonus.processor";
import type { ReferralBonusService } from "./referral-bonus.service";
import type { ReferralBonusJobData } from "../queue/queue.constants";

const WORKER = "22222222-2222-4222-8222-222222222222";
const ACCRUAL = "44444444-4444-4444-8444-444444444444";

function make(outcome: unknown) {
  const bonus = { evaluate: vi.fn().mockResolvedValue(outcome) };
  return {
    processor: new ReferralBonusProcessor(bonus as unknown as ReferralBonusService),
    bonus,
  };
}

const job = (trigger: ReferralBonusJobData["trigger"]): Job<ReferralBonusJobData> =>
  ({ data: { invitedWorkerId: WORKER, trigger } }) as Job<ReferralBonusJobData>;

describe("ReferralBonusProcessor — the consumer of both real triggers", () => {
  it("evaluates the referred worker on a profile_confirmed job", async () => {
    const { processor, bonus } = make({ accrued: false, reason: "not_unlocked" });
    await processor.process(job("profile_confirmed"));
    expect(bonus.evaluate).toHaveBeenCalledWith(WORKER);
  });

  it("evaluates the SAME way on an unlock_granted job — the trigger never steers the rule", async () => {
    const { processor, bonus } = make({ accrued: false, reason: "profile_incomplete" });
    await processor.process(job("unlock_granted"));
    // Both legs are re-read from the database; `trigger` is observability only, so a
    // producer can never cause an accrual by claiming the wrong trigger.
    expect(bonus.evaluate).toHaveBeenCalledWith(WORKER);
    expect(bonus.evaluate).toHaveBeenCalledTimes(1);
  });

  it("returns the outcome so a failed evaluation can be retried by BullMQ", async () => {
    const { processor } = make({ accrued: true, accrual_id: ACCRUAL, amount_inr: 20 });
    await expect(processor.process(job("unlock_granted"))).resolves.toEqual({
      accrued: true,
      accrual_id: ACCRUAL,
      amount_inr: 20,
    });
  });

  it("never logs a worker id (a duplicate_phone line plus an id asserts a relationship)", async () => {
    const { processor } = make({ accrued: true, accrual_id: ACCRUAL, amount_inr: 20 });
    const log = vi.spyOn(
      (processor as unknown as { logger: { log: (m: string) => void } }).logger,
      "log",
    );
    await processor.process(job("unlock_granted"));
    for (const call of log.mock.calls) {
      expect(String(call[0])).not.toContain(WORKER);
      expect(String(call[0])).not.toContain(ACCRUAL);
    }
  });

  it("stays quiet on the overwhelmingly common no-op (most workers were never referred)", async () => {
    const { processor } = make({ accrued: false, reason: "no_referral" });
    const log = vi.spyOn(
      (processor as unknown as { logger: { log: (m: string) => void } }).logger,
      "log",
    );
    await processor.process(job("profile_confirmed"));
    expect(log).not.toHaveBeenCalled();
  });
});
