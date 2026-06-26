import type { CreditTopUp, UnlockHistoryItem } from "./contracts";

/**
 * PURE credit-history math — merge + sort + 12-month expiry bucketing (ADR-0019 Phase 1).
 *
 * Exported and side-effect-free so the date/bucketing logic is unit-testable WITHOUT a
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

/** One top-up's 12-month expiry bucket (purchased credits expire `months` after purchase). */
export interface CreditExpiry {
  topUpId: string;
  credits: number;
  purchasedAt: string;
  /** `purchasedAt` + `months` (default 12), clamped for short months (e.g. Jan 31 → Feb). */
  expiresAt: string;
}

/**
 * Add `months` to an ISO timestamp (UTC), clamping the day to the target month's last day
 * (so Jan 31 + 1 month → Feb 28/29, not Mar 3). Deterministic — no `Date.now()`. Returns the
 * input unchanged if it is not a parseable date (fail-safe; the caller already has valid ISO).
 */
export function addMonthsIso(iso: string, months: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = d.getUTCDate();
  // First land on day 1 of the target month (avoids rollover), then clamp the day.
  const target = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth() + months,
      1,
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    ),
  );
  const lastDayOfTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return target.toISOString();
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

/**
 * The credit-expiry schedule for purchased credits, derived from each top-up's purchase
 * timestamp, SOONEST-EXPIRING FIRST. Pure. PII-free (ids/amounts only). `months` is supplied
 * by the caller from config (`creditValidityMonths()`, default 12) — not hardcoded here; the
 * default is only a sensible fallback for direct/test callers.
 */
export function creditExpirySchedule(topUps: CreditTopUp[], months = 12): CreditExpiry[] {
  return topUps
    .map((t) => ({
      topUpId: t.topUpId,
      credits: t.credits,
      purchasedAt: t.createdAt,
      expiresAt: addMonthsIso(t.createdAt, months),
    }))
    .sort((a, b) => (a.expiresAt < b.expiresAt ? -1 : a.expiresAt > b.expiresAt ? 1 : 0));
}
