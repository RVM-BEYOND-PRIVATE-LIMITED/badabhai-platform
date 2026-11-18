import type { CreditTopUp, UnlockHistoryItem } from "./contracts";

/**
 * PURE credit-history math — merge + sort (ADR-0019 Phase 1). No credit expiry is worked out
 * in the browser: a lot's expiry is the server's to state (#2744 item 1, BB-D-04).
 *
 * Exported and side-effect-free so the merge/sort logic is unit-testable WITHOUT a
 * render (same discipline as `toPayerJobPostingBody`). No I/O, no `Date.now()` — every
 * function is a deterministic transform of its inputs. PII-FREE: it moves only ids, amounts,
 * config pack codes, and timestamps — NEVER a worker name/phone.
 *
 * The history aggregates the caller's OWN credit movements:
 *  - SPENDS: one per unlock from GET /payer/unlocks (each unlock spends exactly 1 credit).
 *  - TOP-UPS: from the mock ledger (a successful mock purchase).
 */

/** A single PII-free credit movement on the caller's own ledger. */
export interface CreditTransaction {
  /** Opaque id (the unlock id or top-up id) — never a worker identity. */
  id: string;
  kind: "topup" | "spend";
  /** ISO timestamp of the movement. */
  at: string;
  /** Signed credit delta: +credits for a top-up, -1 for an unlock spend. */
  credits: number;
  /** Rupees paid (top-ups only; MOCK money — config-priced, never client-supplied). */
  priceInr?: number;
  /** The config pack code (top-ups only). */
  packCode?: string;
}

/**
 * Merge unlock spends + mock-ledger top-ups into ONE PII-free transaction list, NEWEST
 * FIRST. Each unlock is a single −1-credit spend (1 unlock = 1 credit). Pure: a stable
 * transform of the two inputs (ISO strings sort lexicographically = chronologically).
 */
export function buildTransactionHistory(input: {
  unlocks: UnlockHistoryItem[];
  topUps: CreditTopUp[];
}): CreditTransaction[] {
  const spends: CreditTransaction[] = input.unlocks.map((u) => ({
    id: u.unlockId,
    kind: "spend",
    at: u.createdAt,
    credits: -1, // every unlock spends exactly 1 credit
  }));
  const tops: CreditTransaction[] = input.topUps.map((t) => ({
    id: t.topUpId,
    kind: "topup",
    at: t.createdAt,
    credits: t.credits,
    priceInr: t.priceInr,
    packCode: t.packCode,
  }));
  return [...tops, ...spends].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
