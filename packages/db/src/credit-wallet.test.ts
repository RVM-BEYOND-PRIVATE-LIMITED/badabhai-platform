/**
 * #2749 — the wallet helpers' pure parts: the spend order, the alignment plan, the keys and the
 * warning line. What needs a real Postgres (the row locks, the CHECKs, the unique keys, the
 * concurrency) is proven by `apps/api/src/unlocks/credit-lots.db.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

import {
  compareLotSpendOrder,
  creditLotExpiredIdempotencyKey,
  dueCreditsAfterAlignment,
  LOT_ALIGNMENT_LOG_PREFIX,
  freeTierIdempotencyKey,
  grantCreditsWithinTx,
  lotAlignmentWarning,
  planLotAlignment,
  sumOpenCredits,
  type OpenCreditLot,
  type WalletTx,
} from "./credit-wallet";
import { freeTierIdempotencyKey as scriptKey } from "./grant-free-tier";

const day = (n: number): Date => new Date(Date.UTC(2026, 10, n));

function lot(over: Partial<OpenCreditLot> & { id: string }): OpenCreditLot {
  return {
    source: "pack",
    creditsRemaining: 5,
    expiresAt: null,
    createdAt: day(1),
    due: false,
    ...over,
  };
}

describe("compareLotSpendOrder — soonest expiry first, never-expiring last (B7-08)", () => {
  it("spends the day-10 lot before the day-50 lot, and a lot that never expires last", () => {
    const never = lot({ id: "c", expiresAt: null, createdAt: day(1) });
    const late = lot({ id: "b", expiresAt: day(50), createdAt: day(1) });
    const soon = lot({ id: "a", expiresAt: day(10), createdAt: day(5) });
    expect([never, late, soon].sort(compareLotSpendOrder).map((l) => l.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("breaks an expiry tie by age, then by id (a total order)", () => {
    const younger = lot({ id: "a", expiresAt: day(10), createdAt: day(3) });
    const older = lot({ id: "z", expiresAt: day(10), createdAt: day(2) });
    const twin = lot({ id: "b", expiresAt: day(10), createdAt: day(2) });
    expect([younger, older, twin].sort(compareLotSpendOrder).map((l) => l.id)).toEqual([
      "b",
      "z",
      "a",
    ]);
    // Equal dates in different Date objects compare equal.
    const n1 = lot({ id: "x", expiresAt: null, createdAt: new Date(day(4).getTime()) });
    const n2 = lot({ id: "x", expiresAt: null, createdAt: new Date(day(4).getTime()) });
    expect(compareLotSpendOrder(n1, n2)).toBe(0);
  });
});

describe("planLotAlignment — balance is the source of truth", () => {
  it("does nothing when the open lots already hold the balance", () => {
    expect(planLotAlignment([lot({ id: "a", creditsRemaining: 3 })], 3)).toEqual({
      action: "none",
    });
    expect(planLotAlignment([], 0)).toEqual({ action: "none" });
  });

  it("tops up the open never-expiring legacy lot when the lots hold less", () => {
    const lots = [
      lot({ id: "pack", source: "pack", creditsRemaining: 2 }),
      lot({ id: "legacy", source: "legacy", creditsRemaining: 1 }),
    ];
    expect(planLotAlignment(lots, 7)).toEqual({ action: "top_up", credits: 4, lotId: "legacy" });
  });

  it("inserts a legacy lot when no open legacy lot never expires", () => {
    const lots = [
      lot({ id: "expiring-legacy", source: "legacy", creditsRemaining: 1, expiresAt: day(30) }),
    ];
    expect(planLotAlignment(lots, 3)).toEqual({ action: "top_up", credits: 2, lotId: null });
    expect(planLotAlignment([], 5)).toEqual({ action: "top_up", credits: 5, lotId: null });
  });

  it("removes the excess soonest-expiring first — the order a spend would have taken it", () => {
    const lots = [
      lot({ id: "never", creditsRemaining: 10, expiresAt: null }),
      lot({ id: "day50", creditsRemaining: 4, expiresAt: day(50) }),
      lot({ id: "day10", creditsRemaining: 2, expiresAt: day(10) }),
    ];
    // Σ 16, balance 11 → remove 5: 2 from day10, 3 from day50, none from the never lot.
    expect(planLotAlignment(lots, 11)).toEqual({
      action: "trim",
      credits: 5,
      takes: [
        { lotId: "day10", credits: 2 },
        { lotId: "day50", credits: 3 },
      ],
    });
  });

  it("can trim a wallet to zero", () => {
    const lots = [lot({ id: "a", creditsRemaining: 2 }), lot({ id: "b", creditsRemaining: 1 })];
    const plan = planLotAlignment(lots, 0);
    expect(plan).toMatchObject({ action: "trim", credits: 3 });
    expect(sumOpenCredits(lots)).toBe(3);
  });

  it("refuses a negative or fractional balance", () => {
    expect(() => planLotAlignment([], -1)).toThrow(RangeError);
    expect(() => planLotAlignment([], 1.5)).toThrow(RangeError);
  });
});

describe("dueCreditsAfterAlignment — what a spend would expire first (#2749 review)", () => {
  it("counts the due lots' credits; lots that are not due do not count", () => {
    const lots = [
      lot({ id: "due", creditsRemaining: 3, expiresAt: day(1), due: true }),
      lot({ id: "live", creditsRemaining: 5, expiresAt: day(40) }),
      lot({ id: "never", creditsRemaining: 2 }),
    ];
    expect(dueCreditsAfterAlignment(lots, planLotAlignment(lots, 10))).toBe(3);
  });

  it("a trim taken from a due lot first shrinks what is due", () => {
    const lots = [
      lot({ id: "due", creditsRemaining: 3, expiresAt: day(1), due: true }),
      lot({ id: "never", creditsRemaining: 4 }),
    ];
    // Σ 7, balance 5: the trim takes 2 from the soonest-expiring (the due lot).
    expect(dueCreditsAfterAlignment(lots, planLotAlignment(lots, 5))).toBe(1);
    // Balance 3: the 4-credit trim empties the due lot (3) before it takes 1 from the other.
    expect(dueCreditsAfterAlignment(lots, planLotAlignment(lots, 3))).toBe(0);
  });

  it("a top-up never touches a due lot", () => {
    const lots = [lot({ id: "due", creditsRemaining: 2, expiresAt: day(1), due: true })];
    expect(dueCreditsAfterAlignment(lots, planLotAlignment(lots, 6))).toBe(2);
  });
});

describe("keys and the warning line", () => {
  it("a lot expires once, keyed by the lot", () => {
    expect(creditLotExpiredIdempotencyKey("lot-1")).toBe("credit_lot_expired:lot-1");
  });

  it("the free-tier key is the D6 script's, byte for byte (signup and the backfill dedupe)", () => {
    expect(freeTierIdempotencyKey("p-1")).toBe("free_tier_grant:p-1");
    expect(scriptKey).toBe(freeTierIdempotencyKey);
  });

  it("warns only when an alignment acted, with ids and numbers only", () => {
    expect(
      lotAlignmentWarning("w-1", { action: "none", credits: 0, openBefore: 4, balance: 4 }),
    ).toBeNull();
    expect(
      lotAlignmentWarning("w-1", { action: "top_up", credits: 3, openBefore: 1, balance: 4 }),
    ).toBe(
      "credit-wallet: lots out of step with balance (self-healed; balance unchanged) wallet=w-1 " +
        "action=top_up credits=3 open_before=1 balance=4",
    );
    // The stable prefix an alert keys on.
    expect(LOT_ALIGNMENT_LOG_PREFIX).toBe("credit-wallet: lots out of step with balance");
  });
});

describe("grantCreditsWithinTx — input guard", () => {
  it("refuses a non-positive or fractional grant before touching the database", async () => {
    const tx = {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
    } as unknown as WalletTx;
    for (const credits of [0, -5, 2.5]) {
      await expect(
        grantCreditsWithinTx(tx, {
          payerId: "p-1",
          credits,
          lot: { source: "goodwill" },
          ledger: { reason: "grant" },
        }),
      ).rejects.toThrow(RangeError);
    }
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.select).not.toHaveBeenCalled();
  });
});
