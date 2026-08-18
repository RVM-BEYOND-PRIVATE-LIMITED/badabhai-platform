import { describe, it, expect } from "vitest";
import { applyCreditGrantOutcome, type CreditGrantFormState } from "./credit-grant-outcome";
import type { AdminActionOutcome } from "./admin-action-result";

/**
 * The credit-grant idempotency key across a SEQUENCE of submits — the money property.
 *
 * These are written as sequences rather than single transitions on purpose: the bug this
 * guards against only exists across two submits from one mount (`router.refresh()` re-renders
 * the server tree WITHOUT remounting the panel, so the key survives), and a per-call
 * assertion would have passed the whole time the bug was live.
 */

const ok = (changed: boolean): AdminActionOutcome => ({
  ok: true,
  changed,
  message: changed ? "Granted 100 credits. New balance: 1100." : "No change.",
});
const failed: AdminActionOutcome = { ok: false, error: "Payer is suspended" };

/** A deterministic stand-in for `crypto.randomUUID()` that also counts its calls. */
function keyMinter() {
  let n = 0;
  const minted: string[] = [];
  return {
    mint: () => {
      n += 1;
      const k = `key-${n}`;
      minted.push(k);
      return k;
    },
    get calls() {
      return n;
    },
    minted,
  };
}

const start = (): CreditGrantFormState => ({ idempotencyKey: "key-0", amount: "100" });

describe("applyCreditGrantOutcome — key rotation", () => {
  it("a CONFIRMED grant rotates the key, so the next grant sends a DIFFERENT one", () => {
    const m = keyMinter();
    const first = start();
    const afterFirst = applyCreditGrantOutcome(first, ok(true), m.mint);

    expect(afterFirst.idempotencyKey).not.toBe(first.idempotencyKey);
    // The operator now types 200 and submits again — the key that goes on the wire is the
    // rotated one, so the second grant is a NEW ledger movement, not a replay of the first.
    const second = { ...afterFirst, amount: "200" };
    expect(second.idempotencyKey).toBe("key-1");
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("a FAILED grant does NOT rotate — the retry replays the same key, exactly-once", () => {
    const m = keyMinter();
    const first = start();
    const afterFailure = applyCreditGrantOutcome(first, failed, m.mint);

    expect(afterFailure.idempotencyKey).toBe(first.idempotencyKey);
    // And nothing was minted at all: a lost response may mean the server DID apply the
    // grant, so a fresh key here is how one intended grant becomes two real ones.
    expect(m.calls).toBe(0);
  });

  it("a successful NO-OP still rotates — that key is spent on the server either way", () => {
    const m = keyMinter();
    const after = applyCreditGrantOutcome(start(), ok(false), m.mint);
    expect(after.idempotencyKey).toBe("key-1");
    expect(m.calls).toBe(1);
  });

  it("three submits from one mount use three distinct keys", () => {
    const m = keyMinter();
    let state = start();
    const used: string[] = [];
    for (const _ of [1, 2, 3]) {
      used.push(state.idempotencyKey);
      state = applyCreditGrantOutcome({ ...state, amount: "100" }, ok(true), m.mint);
    }
    expect(new Set(used).size).toBe(3);
  });

  it("a failed submit between two successes does not consume a key", () => {
    const m = keyMinter();
    let state = start();
    const firstKey = state.idempotencyKey;

    state = applyCreditGrantOutcome(state, failed, m.mint);
    expect(state.idempotencyKey).toBe(firstKey); // retry is the SAME request

    state = applyCreditGrantOutcome(state, ok(true), m.mint); // the retry lands
    const secondKey = state.idempotencyKey;
    expect(secondKey).not.toBe(firstKey);

    state = applyCreditGrantOutcome({ ...state, amount: "200" }, ok(true), m.mint);
    expect(state.idempotencyKey).not.toBe(secondKey);
    expect(m.calls).toBe(2); // exactly one per CONFIRMED response
  });
});

describe("applyCreditGrantOutcome — the amount field", () => {
  it("clears the amount after a real grant, so the next one is typed deliberately", () => {
    expect(applyCreditGrantOutcome(start(), ok(true), () => "k").amount).toBe("");
  });

  it("keeps the amount after a no-op — the operator still has to decide about that grant", () => {
    expect(applyCreditGrantOutcome(start(), ok(false), () => "k").amount).toBe("100");
  });

  it("keeps the amount after a failure, so a retry does not need retyping", () => {
    expect(applyCreditGrantOutcome(start(), failed, () => "k").amount).toBe("100");
  });

  it("never mutates the state it was given", () => {
    const before = start();
    applyCreditGrantOutcome(before, ok(true), () => "k");
    expect(before).toEqual({ idempotencyKey: "key-0", amount: "100" });
  });
});
