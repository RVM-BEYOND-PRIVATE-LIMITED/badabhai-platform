import { describe, it, expect, vi } from "vitest";
import { CreditLotExpirySweepProcessor } from "./credit-lot-expiry-sweep.processor";

/**
 * Unit tests for the #2749 credit-lot expiry sweep processor. The processor is a thin shell —
 * registration + the bounded work list + one transaction per wallet + count logs — around the
 * repository's two calls, whose SQL (the wallet lock, the `expired` line once per lot) is proven
 * against Postgres by `credit-lots.db.test.ts`. These pin the SHELL.
 */

function makeProcessor(opts: {
  intervalMinutes?: number;
  batchLimit?: number;
  wallets?: string[];
  expire?: (wallet: string) => Promise<{ lotsExpired: number; creditsExpired: number }>;
}) {
  const repo = {
    findWalletsWithDueLots: vi.fn(async (_limit: number) => opts.wallets ?? []),
    expireDueLotsForWallet: vi.fn(async (wallet: string) => {
      const done = opts.expire ? await opts.expire(wallet) : { lotsExpired: 1, creditsExpired: 5 };
      return { walletFound: true, balanceAfter: 0, alignment: null, ...done };
    }),
  };
  const queue = { upsertJobScheduler: vi.fn(async () => undefined) };
  const config = {
    CREDIT_LOT_EXPIRY_SWEEP_INTERVAL_MINUTES: opts.intervalMinutes ?? 15,
    CREDIT_LOT_EXPIRY_BATCH_LIMIT: opts.batchLimit ?? 200,
  };
  const processor = new CreditLotExpirySweepProcessor(
    repo as never,
    queue as never,
    config as never,
  );
  return { processor, repo, queue };
}

describe("CreditLotExpirySweepProcessor", () => {
  it("registers ONE repeatable scheduler at boot with the configured cadence (minutes)", async () => {
    const { processor, queue } = makeProcessor({ intervalMinutes: 15 });
    await processor.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    const [id, pattern] = queue.upsertJobScheduler.mock.calls[0] as unknown as [
      string,
      { every: number },
    ];
    expect(id).toBe("credit-lot-expiry-sweep");
    expect(pattern.every).toBe(900_000);
  });

  it("a failed registration WARNS but never fails boot", async () => {
    const { processor, queue } = makeProcessor({});
    queue.upsertJobScheduler.mockRejectedValueOnce(new Error("redis down"));
    await expect(processor.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it("nothing due: reads the bounded work list and touches no wallet", async () => {
    const { processor, repo } = makeProcessor({ batchLimit: 50, wallets: [] });
    expect(await processor.process()).toEqual({
      walletsDue: 0,
      walletsExpired: 0,
      lotsExpired: 0,
      creditsExpired: 0,
      walletsFailed: 0,
    });
    expect(repo.findWalletsWithDueLots).toHaveBeenCalledWith(50);
    expect(repo.expireDueLotsForWallet).not.toHaveBeenCalled();
  });

  it("expires each due wallet in its own call and sums the counts", async () => {
    const { processor, repo } = makeProcessor({ wallets: ["w-1", "w-2", "w-3"] });
    repo.expireDueLotsForWallet
      .mockResolvedValueOnce({ walletFound: true, lotsExpired: 2, creditsExpired: 7 } as never)
      .mockResolvedValueOnce({ walletFound: true, lotsExpired: 0, creditsExpired: 0 } as never)
      .mockResolvedValueOnce({ walletFound: true, lotsExpired: 1, creditsExpired: 3 } as never);
    expect(await processor.process()).toEqual({
      walletsDue: 3,
      walletsExpired: 2, // a wallet a concurrent spend already expired counts as nothing
      lotsExpired: 3,
      creditsExpired: 10,
      walletsFailed: 0,
    });
    expect(repo.expireDueLotsForWallet.mock.calls.map((c) => c[0])).toEqual(["w-1", "w-2", "w-3"]);
  });

  it("one wallet's failure is counted and logged, and never stops the others", async () => {
    const failing = Object.assign(new Error("Failed query"), { cause: { code: "40P01" } });
    const { processor, repo } = makeProcessor({
      wallets: ["w-1", "w-2"],
      expire: async (wallet) => {
        if (wallet === "w-1") throw failing;
        return { lotsExpired: 1, creditsExpired: 4 };
      },
    });
    expect(await processor.process()).toMatchObject({
      walletsDue: 2,
      walletsExpired: 1,
      creditsExpired: 4,
      walletsFailed: 1,
    });
    expect(repo.expireDueLotsForWallet).toHaveBeenCalledTimes(2);
  });

  it("a work-list read failure fails the tick (BullMQ records it; the next tick retries)", async () => {
    const { processor, repo } = makeProcessor({});
    repo.findWalletsWithDueLots.mockRejectedValueOnce(new Error("relation does not exist"));
    await expect(processor.process()).rejects.toThrow("relation does not exist");
  });
});
