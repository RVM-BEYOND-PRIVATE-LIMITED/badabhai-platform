import { describe, expect, it } from "vitest";
import {
  addMonthsIso,
  buildLedgerHistory,
  buildTransactionHistory,
  creditExpirySchedule,
} from "./credit-history";
import type { CreditLedgerItem, CreditTopUp, UnlockHistoryItem } from "./contracts";

/**
 * Pure credit-history math tests — date/bucketing logic verified WITHOUT a render (same
 * discipline as toPayerJobPostingBody). Covers the 12-month expiry math (incl. short-month
 * clamping), the LIVE credit-ledger → transaction mapping (FE-5), the legacy unlock+topup merge,
 * and the PII-free shape.
 */

/** A LIVE credit-ledger row (the PII-free camelCase projection the seam maps from #177). */
const ledgerRow = (over: Partial<CreditLedgerItem> = {}): CreditLedgerItem => ({
  id: "11111111-1111-4111-8111-111111111111",
  reason: "pack_purchase",
  delta: 50,
  packCode: "pack_50",
  priceInr: 2000,
  createdAt: "2026-01-10T08:00:00.000Z",
  ...over,
});

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

describe("addMonthsIso — deterministic month math with short-month clamping", () => {
  it("adds 12 months for a plain date", () => {
    expect(addMonthsIso("2026-03-15T00:00:00.000Z", 12)).toBe("2027-03-15T00:00:00.000Z");
  });

  it("clamps the day when the target month is shorter (Jan 31 + 1mo → Feb 28 in a non-leap year)", () => {
    expect(addMonthsIso("2026-01-31T00:00:00.000Z", 1)).toBe("2026-02-28T00:00:00.000Z");
  });

  it("clamps to Feb 29 in a leap year", () => {
    expect(addMonthsIso("2024-01-31T00:00:00.000Z", 1)).toBe("2024-02-29T00:00:00.000Z");
  });

  it("preserves the time-of-day component", () => {
    expect(addMonthsIso("2026-06-10T13:45:30.000Z", 12)).toBe("2027-06-10T13:45:30.000Z");
  });

  it("echoes a non-parseable input (fail-safe)", () => {
    expect(addMonthsIso("not-a-date", 12)).toBe("not-a-date");
  });
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

describe("buildLedgerHistory — LIVE credit-ledger → transactions (FE-5), newest first, PII-free", () => {
  it("maps a pack_purchase to a +credits top-up (with config ₹) and an unlock_debit to a −1 spend", () => {
    const history = buildLedgerHistory([
      ledgerRow({ id: "p1", reason: "pack_purchase", delta: 50, priceInr: 2000, createdAt: "2026-01-10T00:00:00.000Z" }),
      ledgerRow({ id: "u1", reason: "unlock_debit", delta: -1, packCode: null, priceInr: null, createdAt: "2026-01-12T00:00:00.000Z" }),
    ]);
    const top = history.find((t) => t.kind === "topup")!;
    const spend = history.find((t) => t.kind === "spend")!;
    expect(top.credits).toBe(50);
    expect(top.priceInr).toBe(2000);
    expect(top.packCode).toBe("pack_50");
    expect(spend.credits).toBe(-1);
    expect(spend.id).toBe("u1");
    // A spend carries no ₹/pack (an unlock_debit has neither).
    expect(spend.priceInr).toBeUndefined();
    expect(spend.packCode).toBeUndefined();
  });

  it("sorts strictly newest-first by the LIVE createdAt", () => {
    const history = buildLedgerHistory([
      ledgerRow({ id: "old", createdAt: "2026-01-01T00:00:00.000Z" }),
      ledgerRow({ id: "new", createdAt: "2026-03-01T00:00:00.000Z" }),
      ledgerRow({ id: "mid", reason: "unlock_debit", delta: -1, createdAt: "2026-02-01T00:00:00.000Z" }),
    ]);
    expect(history.map((t) => t.id)).toEqual(["new", "mid", "old"]);
  });

  it("renders a grant/refund positive movement as a top-up (no ₹) — not a spend", () => {
    const history = buildLedgerHistory([
      ledgerRow({ id: "g1", reason: "grant", delta: 3, packCode: null, priceInr: null }),
    ]);
    expect(history[0]!.kind).toBe("topup");
    expect(history[0]!.credits).toBe(3);
    expect(history[0]!.priceInr).toBeUndefined(); // a grant carries no purchase ₹
  });

  it("carries NO worker identity — only opaque ids + amounts (PII-free)", () => {
    const history = buildLedgerHistory([ledgerRow({ id: "u1", reason: "unlock_debit", delta: -1 })]);
    expect(Object.keys(history[0]!)).not.toContain("workerId");
    expect(JSON.stringify(history)).not.toMatch(/phone|\bemail\b|\d{10,}/i);
  });
});

describe("creditExpirySchedule — 12-month expiry derived from the purchase timestamp", () => {
  it("expires 12 months after purchase by default", () => {
    const [e] = creditExpirySchedule([topUp({ createdAt: "2026-01-10T08:00:00.000Z", credits: 50 })]);
    expect(e!.purchasedAt).toBe("2026-01-10T08:00:00.000Z");
    expect(e!.expiresAt).toBe("2027-01-10T08:00:00.000Z");
    expect(e!.credits).toBe(50);
  });

  it("orders the schedule soonest-expiring first", () => {
    const schedule = creditExpirySchedule([
      topUp({ topUpId: "later", createdAt: "2026-06-01T00:00:00.000Z" }),
      topUp({ topUpId: "sooner", createdAt: "2026-01-01T00:00:00.000Z" }),
    ]);
    expect(schedule.map((e) => e.topUpId)).toEqual(["sooner", "later"]);
  });

  it("honours a custom months window", () => {
    const [e] = creditExpirySchedule([topUp({ createdAt: "2026-01-10T00:00:00.000Z" })], 6);
    expect(e!.expiresAt).toBe("2026-07-10T00:00:00.000Z");
  });
});
