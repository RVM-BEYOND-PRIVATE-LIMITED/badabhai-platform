/**
 * ADR-0026 Phase 1 — pure engagement-tier math for the rolling worker session.
 *
 * This module is INTENTIONALLY pure and side-effect free: every function takes the
 * current time as an explicit `nowMs` (no `Date.now()` inside) so the behavior is fully
 * deterministic and unit-testable. The SessionService injects `Date.now()` at the call
 * site; nothing here reads the clock or touches Redis.
 *
 * The engagement tier is a function of how many DISTINCT active IST days a worker has
 * inside the trailing tier window: the more days active, the longer the idle TTL the
 * session is allowed to slide to (a returning, engaged worker is asked to re-auth less
 * often). A hard absolute cap (only an OTP resets it) bounds the whole thing.
 *
 * NONE of this carries PII — it operates on a created-at timestamp, a list of IST date
 * strings, and integer day counts.
 */

/**
 * Engagement tiers (ADR-0026 §Decision). `tier` is the index; `idleDays` is the idle
 * TTL (in days) a session at that tier may slide to. `tierFor(n)` picks the HIGHEST
 * tier whose `minActiveDays <= n`. These are code constants (documented, config-tunable
 * later); the thresholds are: <3 active days → 7d idle, 3–9 → 14d, 10–29 → 30d, >=30 →
 * 60d.
 */
export const SESSION_TIERS: ReadonlyArray<{ minActiveDays: number; idleDays: number }> = [
  { minActiveDays: 0, idleDays: 7 },
  { minActiveDays: 3, idleDays: 14 },
  { minActiveDays: 10, idleDays: 30 },
  { minActiveDays: 30, idleDays: 60 },
] as const;

const MS_PER_DAY = 86_400_000;
/** IST is a fixed UTC+05:30 offset (no DST) — in milliseconds. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** The tier + its idle-day TTL for a worker with `n` distinct active days. */
export function tierFor(n: number): { tier: number; idleDays: number } {
  let chosen = 0;
  for (let i = 0; i < SESSION_TIERS.length; i += 1) {
    if (n >= SESSION_TIERS[i]!.minActiveDays) chosen = i;
  }
  return { tier: chosen, idleDays: SESSION_TIERS[chosen]!.idleDays };
}

/**
 * The IST calendar date ('YYYY-MM-DD') for a given epoch-ms instant. We shift the
 * instant by the fixed IST offset and then read the UTC date parts of the shifted
 * instant — this avoids any host-timezone dependence.
 */
export function istDateString(nowMs: number): string {
  const shifted = new Date(nowMs + IST_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export interface RollingSessionInput {
  /** Epoch-ms of the OTP that minted this session (the absolute-cap anchor). */
  createdViaOtpAtMs: number;
  /** Distinct active IST dates recorded so far (any order; deduped/pruned here). */
  activeDays: readonly string[];
  /** Current time (injected — never read from the clock here). */
  nowMs: number;
  /** Absolute lifetime cap in days from `createdViaOtpAtMs`. */
  absoluteMaxDays: number;
  /** Trailing window in days over which active days count toward the tier. */
  tierWindowDays: number;
}

export type RollingSessionResult =
  | { expired: true }
  | {
      expired: false;
      tier: number;
      /** The pruned + today-appended active-day set (sorted, deduped). */
      activeDays: string[];
      absoluteExpiryMs: number;
      sessionExpiresAtMs: number;
      /** Idle TTL (seconds) to set on the Redis session key. */
      ttlSec: number;
    };

/**
 * Advance the rolling session one step (a refresh/touch):
 *  - prune active days older than the trailing tier window,
 *  - add today's IST date (deduped),
 *  - pick the tier from the resulting count and its idle TTL,
 *  - clamp the new idle expiry to the absolute cap.
 *
 * Returns `{ expired: true }` once past the absolute cap (only an OTP resets that clock).
 * Pure: no clock, no Redis, no mutation of the input arrays.
 */
export function computeRollingSession(input: RollingSessionInput): RollingSessionResult {
  const { createdViaOtpAtMs, activeDays, nowMs, absoluteMaxDays, tierWindowDays } = input;

  const absoluteExpiryMs = createdViaOtpAtMs + absoluteMaxDays * MS_PER_DAY;
  if (nowMs >= absoluteExpiryMs) return { expired: true };

  // Prune by the trailing window using the IST-date string of the window's start.
  // String comparison is valid for 'YYYY-MM-DD' (lexicographic == chronological).
  const windowStartIst = istDateString(nowMs - tierWindowDays * MS_PER_DAY);
  const todayIst = istDateString(nowMs);

  const kept = new Set<string>();
  for (const day of activeDays) {
    if (day >= windowStartIst) kept.add(day);
  }
  kept.add(todayIst);
  const prunedActiveDays = [...kept].sort();

  const n = prunedActiveDays.length;
  const { tier, idleDays } = tierFor(n);

  const idleExpiryMs = nowMs + idleDays * MS_PER_DAY;
  const sessionExpiresAtMs = Math.min(idleExpiryMs, absoluteExpiryMs);
  const ttlSec = Math.ceil((sessionExpiresAtMs - nowMs) / 1000);

  return {
    expired: false,
    tier,
    activeDays: prunedActiveDays,
    absoluteExpiryMs,
    sessionExpiresAtMs,
    ttlSec,
  };
}
