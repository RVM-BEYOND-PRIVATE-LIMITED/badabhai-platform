import "reflect-metadata";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { DEFAULT_MATCH_CONFIG, type MatchConfig } from "@badabhai/match-engine";
import { freeTierIdempotencyKey, grantCreditsWithinTx } from "@badabhai/db";
import { FreeTierService } from "./free-tier.service";

/**
 * B6 / ADR-0036 §8 — the free-tier grant.
 *
 * ONE property matters here and it is worth money: the grant is EXACTLY ONCE. A signup
 * that retries, a redelivered request, or the `db:grant:free-tier` backfill running
 * alongside signup must all leave the payer with 50 credits, not 100.
 *
 * #2749 — the grant goes through `grantCreditsWithinTx` (packages/db credit-wallet.ts), which
 * checks the key under the wallet row lock and writes nothing (no lot, no line, no balance) when
 * it is already on the ledger. The helper is MOCKED here: what this file proves is what the
 * service hands it (the transaction, the wallet, the amount from config, a never-expiring
 * `legacy` lot, a `grant` line, and the key byte-for-byte the D6 backfill's) and what it does
 * with the answer. The helper's own behaviour against Postgres — the lock, the replay that adds
 * nothing — is `credit-lots.db.test.ts`.
 */
vi.mock("@badabhai/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@badabhai/db")>();
  return { ...actual, grantCreditsWithinTx: vi.fn() };
});

const PAYER = "aaaaaaaa-0000-4000-8000-00000000000a";
const NO_ALIGNMENT = { action: "none", credits: 0, openBefore: 0, balance: 0 } as const;

/**
 * @param grants one entry per `grantForPayer` call: `true` = the key was new and the grant
 *   applied, `false` = the key was already on the ledger.
 */
function setup(grants: boolean[], cfg: Partial<MatchConfig> = {}) {
  let call = 0;
  vi.mocked(grantCreditsWithinTx).mockImplementation(async (_tx, input) =>
    (grants[call++] ?? true)
      ? {
          applied: true,
          balanceAfter: input.credits,
          lotId: "lot-1",
          ledgerId: "line-1",
          alignment: NO_ALIGNMENT,
        }
      : {
          applied: false,
          balanceAfter: input.credits,
          ledgerId: "line-1",
          alignment: NO_ALIGNMENT,
        },
  );
  const tx = { tag: "the-transaction" };
  const db = {
    transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const config = { get: vi.fn(async () => ({ ...DEFAULT_MATCH_CONFIG, ...cfg })) };
  const svc = new FreeTierService(db as never, config as never);
  return { svc, db, tx, config };
}

beforeEach(() => {
  vi.mocked(grantCreditsWithinTx).mockReset();
});

describe("FreeTierService — the grant is IDEMPOTENT (the money property)", () => {
  it("grants the configured credits on the first call", async () => {
    const { svc } = setup([true]);
    expect(await svc.grantForPayer(PAYER)).toBe(50);
  });

  it("a SECOND grant (key already on the ledger) returns 0", async () => {
    // Two calls, one applying: the retry (or the concurrent D6 backfill) must leave the payer
    // on 50 and report 0 for the call that granted nothing.
    const { svc } = setup([true, false]);
    expect(await svc.grantForPayer(PAYER)).toBe(50);
    expect(await svc.grantForPayer(PAYER)).toBe(0);
  });

  it("writes the EXACT key the D6 backfill uses, a never-expiring legacy lot and a `grant` line", async () => {
    const { svc } = setup([true]);
    await svc.grantForPayer(PAYER);

    const [, input] = vi.mocked(grantCreditsWithinTx).mock.calls[0]!;
    // `db:grant:free-tier` keys existing payers with the SAME function. If these two strings ever
    // diverged, signup and the backfill would stop deduplicating each other and every backfilled
    // payer would get a second 50.
    expect(input.ledger.idempotencyKey).toBe(freeTierIdempotencyKey(PAYER));
    expect(input.ledger.idempotencyKey).toBe(`free_tier_grant:${PAYER}`);
    expect(input).toEqual({
      payerId: PAYER, // the account id: actor-keyed by design (a named §4 exception)
      credits: 50,
      lot: { source: "legacy", expiresAt: null },
      ledger: { reason: "grant", idempotencyKey: `free_tier_grant:${PAYER}` },
    });
  });

  it("grants inside ONE transaction, on the transaction handle (never the bare connection)", async () => {
    const { svc, db, tx } = setup([true]);
    await svc.grantForPayer(PAYER);

    expect(db.transaction).toHaveBeenCalledOnce();
    expect(vi.mocked(grantCreditsWithinTx).mock.calls[0]![0]).toBe(tx);
  });
});

describe("FreeTierService — the amount is CONFIG, never a constant", () => {
  it("grants what match_config says", async () => {
    const { svc } = setup([true], { freeUnlockCredits: 25 });

    expect(await svc.grantForPayer(PAYER)).toBe(25);
    expect(vi.mocked(grantCreditsWithinTx).mock.calls[0]![1].credits).toBe(25);
  });

  it("a zero (or disabled) grant writes NOTHING AT ALL — no empty ledger row", async () => {
    const { svc, db } = setup([true], { freeUnlockCredits: 0 });

    expect(await svc.grantForPayer(PAYER)).toBe(0);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(grantCreditsWithinTx).not.toHaveBeenCalled();
  });
});

describe("FreeTierService — a failed grant must never cost a signup", () => {
  it("grantQuietly swallows what grantForPayer throws (same failure, two contracts)", async () => {
    const { svc, db } = setup([true]);
    db.transaction.mockRejectedValue(new Error("deadlock detected"));

    // The differential IS the test: the strict path still surfaces the failure, so the
    // quiet path is a deliberate wrapper and not a service that cannot fail.
    await expect(svc.grantForPayer(PAYER)).rejects.toThrow("deadlock detected");
    await expect(svc.grantQuietly(PAYER)).resolves.toBeUndefined();
  });

  it("swallows a NON-Error rejection too (a thrown string must not escape signup)", async () => {
    const { svc, db } = setup([true]);
    // A driver that rejects with a string would sail past an `instanceof Error` handler
    // written the obvious way, and the payer's signup would 500 on a credit grant.
    db.transaction.mockRejectedValue("connection terminated unexpectedly");
    await expect(svc.grantQuietly(PAYER)).resolves.toBeUndefined();
  });

  it("grantQuietly still performs the grant on the happy path", async () => {
    const { svc } = setup([true]);
    await svc.grantQuietly(PAYER);
    expect(grantCreditsWithinTx).toHaveBeenCalledTimes(1);
  });
});
