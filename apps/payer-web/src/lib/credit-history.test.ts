import { describe, expect, it } from "vitest";
import {
  buildTransactionHistory,
  creditLotSchedule,
  nextCreditExpiry,
} from "./credit-history";
import type { CreditLot, CreditTopUp, UnlockHistoryItem } from "./contracts";

/**
 * Pure credit-history math tests — merge/sort logic verified WITHOUT a render (same
 * discipline as toPayerJobPostingBody). Covers the merge+sort of unlock spends + mock-ledger
 * top-ups and the PII-free shape — and that no credit expiry is worked out here (#2744).
 */

const topUp = (over: Partial<CreditTopUp> = {}): CreditTopUp => ({
  topUpId: "11111111-1111-4111-8111-111111111111",
  packCode: "pack_50",
  credits: 50,
  priceInr: 2000,
  createdAt: "2026-01-10T08:00:00.000Z",
  ...over,
});

const unlock = (over: Partial<UnlockHistoryItem> = {}): UnlockHistoryItem => ({
  unlockId: "22222222-2222-4222-8222-222222222222",
  workerId: "99999999-9999-4999-8999-999999999999",
  status: "granted",
  createdAt: "2026-01-12T09:00:00.000Z",
  expiresAt: "2026-01-26T09:00:00.000Z",
  ...over,
});

describe("buildTransactionHistory — merge spends + top-ups, newest first, PII-free", () => {
  it("renders each unlock as a −1 spend and each top-up as a +credits movement", () => {
    const history = buildTransactionHistory({
      unlocks: [unlock({ unlockId: "u1", createdAt: "2026-01-12T00:00:00.000Z" })],
      topUps: [topUp({ topUpId: "t1", credits: 50, createdAt: "2026-01-10T00:00:00.000Z" })],
    });
    const spend = history.find((t) => t.kind === "spend")!;
    const top = history.find((t) => t.kind === "topup")!;
    expect(spend.credits).toBe(-1);
    expect(spend.id).toBe("u1");
    expect(top.credits).toBe(50);
    expect(top.priceInr).toBe(2000);
    expect(top.packCode).toBe("pack_50");
  });

  it("sorts strictly newest-first by timestamp", () => {
    const history = buildTransactionHistory({
      unlocks: [
        unlock({ unlockId: "u-old", createdAt: "2026-01-01T00:00:00.000Z" }),
        unlock({ unlockId: "u-new", createdAt: "2026-03-01T00:00:00.000Z" }),
      ],
      topUps: [topUp({ topUpId: "t-mid", createdAt: "2026-02-01T00:00:00.000Z" })],
    });
    expect(history.map((t) => t.id)).toEqual(["u-new", "t-mid", "u-old"]);
  });

  it("carries NO worker identity — only the opaque unlock id and amounts (PII-free)", () => {
    const history = buildTransactionHistory({ unlocks: [unlock({ unlockId: "u1" })], topUps: [] });
    const keys = Object.keys(history[0]!);
    expect(keys).not.toContain("workerId");
    expect(JSON.stringify(history)).not.toContain("99999999-9999-4999-8999-999999999999");
  });
});

describe("#2939 — expiry is the wallet's real lot timestamp, never computed here", () => {
  const lot = (over: Partial<CreditLot> = {}): CreditLot => ({
    source: "purchased",
    creditsRemaining: 10,
    creditsGranted: 10,
    expiresAt: null,
    packCode: null,
    ...over,
  });

  it("exports no month arithmetic — a lot's expiry is the server's", async () => {
    const exported = Object.keys(await import("./credit-history"));
    expect(exported).toContain("buildTransactionHistory");
    expect(exported).toContain("creditLotSchedule");
    expect(exported.filter((name) => /month|validity/i.test(name))).toEqual([]);
    // …nor a browser-side credit validity setting to feed one.
    const config = Object.keys(await import("./pricing-config"));
    expect(config.filter((name) => /validity|month/i.test(name))).toEqual([]);
  });

  it("lists open lots soonest-expiring first, no-expiry lots last", () => {
    const schedule = creditLotSchedule([
      lot({ source: "legacy", creditsRemaining: 50 }),
      lot({ source: "purchased", expiresAt: "2027-01-10T00:00:00.000Z" }),
      lot({ source: "migrated", expiresAt: "2026-12-18T00:00:00.000Z" }),
    ]);
    expect(schedule.map((e) => e.source)).toEqual(["migrated", "purchased", "legacy"]);
    expect(schedule[0]!.sourceLabel).toBe("Moved from Campus");
    expect(schedule[1]!.sourceLabel).toBe("Purchased");
    expect(schedule[2]!.sourceLabel).toBe("Older balance");
    expect(schedule[2]!.expiresAt).toBeNull();
  });

  it("skips spent lots and sums the credits on the earliest real expiry", () => {
    const next = nextCreditExpiry([
      lot({ source: "spent", creditsRemaining: 0, expiresAt: "2026-12-01T00:00:00.000Z" }),
      lot({ source: "migrated", creditsRemaining: 18, expiresAt: "2026-12-18T00:00:00.000Z" }),
      lot({ source: "returned", creditsRemaining: 12, expiresAt: "2026-12-18T00:00:00.000Z" }),
      lot({ source: "legacy", creditsRemaining: 50 }),
    ]);
    expect(next).toEqual({ credits: 30, expiresAt: "2026-12-18T00:00:00.000Z" });
    expect(creditLotSchedule([lot({ source: "returned" })]).filter((e) => e.source === "returned")).toHaveLength(1);
  });

  it("returns null when no open lot expires", () => {
    expect(nextCreditExpiry([lot({ source: "legacy", creditsRemaining: 50 })])).toBeNull();
  });
});
