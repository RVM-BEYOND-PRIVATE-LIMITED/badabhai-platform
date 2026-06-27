import { describe, it, expect } from "vitest";
import {
  tierFor,
  istDateString,
  computeRollingSession,
  SESSION_TIERS,
} from "./session-tiers";

const MS_PER_DAY = 86_400_000;
// A fixed anchor well inside any cap: 2026-06-27T00:00:00Z.
const NOW = Date.UTC(2026, 5, 27, 0, 0, 0);

describe("tierFor — highest tier whose minActiveDays <= n", () => {
  it("0 and 2 active days are tier 0 (7d idle)", () => {
    expect(tierFor(0)).toEqual({ tier: 0, idleDays: 7 });
    expect(tierFor(2)).toEqual({ tier: 0, idleDays: 7 });
  });
  it("3 active days crosses into tier 1 (14d idle)", () => {
    expect(tierFor(3)).toEqual({ tier: 1, idleDays: 14 });
    expect(tierFor(9)).toEqual({ tier: 1, idleDays: 14 });
  });
  it("10 active days is tier 2 (30d idle)", () => {
    expect(tierFor(10)).toEqual({ tier: 2, idleDays: 30 });
    expect(tierFor(29)).toEqual({ tier: 2, idleDays: 30 });
  });
  it("30+ active days is the top tier 3 (60d idle)", () => {
    expect(tierFor(30)).toEqual({ tier: 3, idleDays: 60 });
    expect(tierFor(1000)).toEqual({ tier: 3, idleDays: 60 });
  });
  it("the tier table is monotonic in both thresholds and idle days", () => {
    for (let i = 1; i < SESSION_TIERS.length; i += 1) {
      expect(SESSION_TIERS[i]!.minActiveDays).toBeGreaterThan(SESSION_TIERS[i - 1]!.minActiveDays);
      expect(SESSION_TIERS[i]!.idleDays).toBeGreaterThan(SESSION_TIERS[i - 1]!.idleDays);
    }
  });
});

describe("istDateString — IST (UTC+05:30) calendar date", () => {
  it("rolls to the NEXT day after 18:30 UTC (which is 00:00 IST)", () => {
    // 2026-06-27T18:29:00Z is still 2026-06-27 23:59 IST.
    expect(istDateString(Date.UTC(2026, 5, 27, 18, 29, 0))).toBe("2026-06-27");
    // 2026-06-27T18:30:00Z is exactly 2026-06-28 00:00 IST → next IST day.
    expect(istDateString(Date.UTC(2026, 5, 27, 18, 30, 0))).toBe("2026-06-28");
  });
  it("a mid-UTC-day instant maps to the same IST date", () => {
    expect(istDateString(Date.UTC(2026, 5, 27, 6, 0, 0))).toBe("2026-06-27");
  });
});

describe("computeRollingSession", () => {
  it("a brand-new session (no prior active days) lands on tier 0 with a 7d idle ttl", () => {
    const res = computeRollingSession({
      createdViaOtpAtMs: NOW,
      activeDays: [],
      nowMs: NOW,
      absoluteMaxDays: 90,
      tierWindowDays: 60,
    });
    expect(res.expired).toBe(false);
    if (res.expired) return;
    expect(res.tier).toBe(0);
    expect(res.activeDays).toEqual(["2026-06-27"]);
    expect(res.ttlSec).toBe(7 * 86400);
  });

  it("dedups today's IST date — re-touching the same day does not double-count", () => {
    const res = computeRollingSession({
      createdViaOtpAtMs: NOW,
      activeDays: ["2026-06-27"],
      nowMs: NOW,
      absoluteMaxDays: 90,
      tierWindowDays: 60,
    });
    expect(res.expired).toBe(false);
    if (res.expired) return;
    expect(res.activeDays).toEqual(["2026-06-27"]);
    expect(res.tier).toBe(0);
  });

  it("prunes active days older than the trailing tier window", () => {
    // One day inside the 60d window, one far outside; plus today.
    const insideWindow = istDateString(NOW - 10 * MS_PER_DAY);
    const outsideWindow = istDateString(NOW - 200 * MS_PER_DAY);
    const res = computeRollingSession({
      createdViaOtpAtMs: NOW - 200 * MS_PER_DAY,
      activeDays: [outsideWindow, insideWindow],
      nowMs: NOW,
      absoluteMaxDays: 365, // keep the absolute cap out of the way here
      tierWindowDays: 60,
    });
    expect(res.expired).toBe(false);
    if (res.expired) return;
    expect(res.activeDays).not.toContain(outsideWindow);
    expect(res.activeDays).toContain(insideWindow);
    expect(res.activeDays).toContain(istDateString(NOW));
  });

  it("crosses into tier 1 at 3 distinct in-window active days", () => {
    const d1 = istDateString(NOW - 2 * MS_PER_DAY);
    const d2 = istDateString(NOW - 1 * MS_PER_DAY);
    // d1, d2, today → 3 distinct days → tier 1 (14d idle).
    const res = computeRollingSession({
      createdViaOtpAtMs: NOW - 5 * MS_PER_DAY,
      activeDays: [d1, d2],
      nowMs: NOW,
      absoluteMaxDays: 90,
      tierWindowDays: 60,
    });
    expect(res.expired).toBe(false);
    if (res.expired) return;
    expect(res.activeDays).toHaveLength(3);
    expect(res.tier).toBe(1);
    expect(res.ttlSec).toBe(14 * 86400);
  });

  it("clamps the idle expiry to the absolute cap (min wins near the cap)", () => {
    // Created 88 days ago, 90d cap → only ~2 days of absolute life left, but a tier-0
    // idle would grant 7. The session ttl must clamp to the absolute cap (~2 days).
    const createdViaOtpAtMs = NOW - 88 * MS_PER_DAY;
    const res = computeRollingSession({
      createdViaOtpAtMs,
      activeDays: [],
      nowMs: NOW,
      absoluteMaxDays: 90,
      tierWindowDays: 60,
    });
    expect(res.expired).toBe(false);
    if (res.expired) return;
    expect(res.sessionExpiresAtMs).toBe(createdViaOtpAtMs + 90 * MS_PER_DAY);
    expect(res.ttlSec).toBe(2 * 86400);
    expect(res.ttlSec).toBeLessThan(7 * 86400);
  });

  it("returns expired once past the absolute cap (only OTP resets the clock)", () => {
    const res = computeRollingSession({
      createdViaOtpAtMs: NOW - 91 * MS_PER_DAY,
      activeDays: [],
      nowMs: NOW,
      absoluteMaxDays: 90,
      tierWindowDays: 60,
    });
    expect(res.expired).toBe(true);
  });

  it("treats exactly AT the absolute cap as expired (nowMs >= absoluteExpiryMs)", () => {
    const createdViaOtpAtMs = NOW - 90 * MS_PER_DAY;
    const res = computeRollingSession({
      createdViaOtpAtMs,
      activeDays: [],
      nowMs: NOW,
      absoluteMaxDays: 90,
      tierWindowDays: 60,
    });
    expect(res.expired).toBe(true);
  });
});
