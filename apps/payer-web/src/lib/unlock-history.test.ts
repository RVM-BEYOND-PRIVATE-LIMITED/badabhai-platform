import { describe, expect, it } from "vitest";
import type { UnlockHistoryItem } from "./contracts";
import {
  isLiveUnlock,
  isoDay,
  liveUnlocksFor,
  recentUnlockRows,
  unlockRow,
} from "./unlock-history";

/**
 * The payer's own unlock history, read for two screens: which company applicant rows start
 * unlocked (F10) and what a dashboard Recent-unlocks row says (F37). Pure; a fixed `now`.
 * Fixtures mirror the wire as getUnlocks maps it (a company unlock carries no posting).
 */

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const W1 = "33333333-0000-4000-8000-000000000001";
const W2 = "33333333-0000-4000-8000-000000000002";
const W3 = "33333333-0000-4000-8000-000000000003";

const item = (over: Partial<UnlockHistoryItem> = {}): UnlockHistoryItem => ({
  unlockId: "44444444-0000-4000-8000-000000000001",
  workerId: W1,
  status: "granted",
  createdAt: "2026-10-01T09:00:00.000Z",
  expiresAt: "2026-10-15T09:00:00.000Z",
  grantedAt: "2026-10-01T09:00:00.000Z",
  ...over,
});

describe("isLiveUnlock — granted AND the window still open", () => {
  it("a granted record whose window ends later is live", () => {
    expect(isLiveUnlock(item(), NOW)).toBe(true);
  });

  it("a record whose window has ENDED is not live, even though its stored status still says granted", () => {
    // Nothing moves a lapsed grant to `expired` in the store; the window end is what decides.
    expect(isLiveUnlock(item({ expiresAt: "2026-10-06T11:59:59.000Z" }), NOW)).toBe(false);
    expect(isLiveUnlock(item({ expiresAt: "2026-10-06T12:00:00.000Z" }), NOW)).toBe(false);
  });

  it("an expired record is not live, whatever its window says; an unreadable end is not live", () => {
    expect(isLiveUnlock(item({ status: "expired" }), NOW)).toBe(false);
    expect(isLiveUnlock(item({ expiresAt: "not a date" }), NOW)).toBe(false);
  });
});

describe("liveUnlocksFor — the feed's live grants, keyed by worker", () => {
  it("returns the granted view for live grants on THIS feed only", () => {
    const out = liveUnlocksFor(
      [
        item({ unlockId: "u-1", workerId: W1 }),
        item({ unlockId: "u-2", workerId: W2, expiresAt: "2026-09-01T00:00:00.000Z" }), // lapsed
        item({ unlockId: "u-3", workerId: W3 }), // live, but not on this feed
      ],
      [W1, W2],
      NOW,
    );
    expect(out).toEqual({
      [W1]: { kind: "granted", unlockId: "u-1", expiresAt: "2026-10-15T09:00:00.000Z" },
    });
  });

  it("one grant opens that worker's row on EVERY feed it appears on (per payer+worker, not per posting)", () => {
    // A company unlock is stored with no posting, so nothing could tie it to one feed — and the
    // grant is the worker's either way (ADR-0010 sign-off 1).
    const history = [item({ unlockId: "u-1", workerId: W1 })];
    const held = { kind: "granted", unlockId: "u-1", expiresAt: "2026-10-15T09:00:00.000Z" };
    expect(liveUnlocksFor(history, [W1, W2], NOW)).toEqual({ [W1]: held });
    expect(liveUnlocksFor(history, [W3, W1], NOW)).toEqual({ [W1]: held });
  });

  it("if two records ever arrive for one worker, the later window wins", () => {
    const out = liveUnlocksFor(
      [
        item({ unlockId: "later", expiresAt: "2026-10-20T00:00:00.000Z" }),
        item({ unlockId: "earlier", expiresAt: "2026-10-10T00:00:00.000Z" }),
      ],
      [W1],
      NOW,
    );
    expect(out[W1]!.unlockId).toBe("later");
  });
});

describe("unlockRow — what a Recent-unlocks row says", () => {
  it("dates: unlocked on the GRANT day (a re-grant moves it), ends on the window end", () => {
    const row = unlockRow(
      item({ createdAt: "2026-08-01T09:00:00.000Z", grantedAt: "2026-10-01T23:30:00.000Z" }),
      NOW,
    );
    expect(row.unlockedOn).toBe("2026-10-01");
    expect(row.endsOn).toBe("2026-10-15");
    // No grant time on the record → its creation day.
    expect(unlockRow(item({ grantedAt: null }), NOW).unlockedOn).toBe("2026-10-01");
  });

  it("live vs ended follows isLiveUnlock (a lapsed 'granted' row reads ended)", () => {
    expect(unlockRow(item(), NOW).live).toBe(true);
    expect(unlockRow(item({ expiresAt: "2026-09-01T00:00:00.000Z" }), NOW).live).toBe(false);
    expect(unlockRow(item({ status: "expired" }), NOW).live).toBe(false);
  });

  it("carries exactly its key, status and days — no worker id, no posting (none is reachable)", () => {
    const row = unlockRow(item(), NOW);
    expect(Object.keys(row).sort()).toEqual(["endsOn", "key", "live", "unlockedOn"]);
    expect(JSON.stringify(row)).not.toContain(W1);
  });
});

describe("recentUnlockRows — newest first by the day each row PRINTS", () => {
  // The API lists by record creation, newest first; a re-grant moves granted_at, not created_at.
  const regrant = item({
    unlockId: "regrant",
    createdAt: "2026-07-01T09:00:00.000Z",
    grantedAt: "2026-10-05T09:00:00.000Z",
  });
  const fresh = item({
    unlockId: "fresh",
    createdAt: "2026-09-20T09:00:00.000Z",
    grantedAt: "2026-09-20T09:00:00.000Z",
  });

  it("orders by the printed unlock day, not the API's creation order", () => {
    const rows = recentUnlockRows([fresh, regrant], NOW);
    expect(rows.map((r) => r.key)).toEqual(["regrant", "fresh"]);
    expect(rows.map((r) => r.unlockedOn)).toEqual(["2026-10-05", "2026-09-20"]);
  });

  it("the limit keeps the most recently UNLOCKED, not the first the API listed", () => {
    const older = Array.from({ length: 5 }, (_, i) =>
      item({
        unlockId: `old-${i}`,
        createdAt: `2026-09-2${i}T09:00:00.000Z`,
        grantedAt: `2026-09-0${i + 1}T09:00:00.000Z`,
      }),
    );
    // The API puts the re-grant LAST (oldest creation); it is the newest unlock.
    const rows = recentUnlockRows([...older.reverse(), regrant], NOW);
    expect(rows).toHaveLength(5);
    expect(rows[0]!.key).toBe("regrant");
    expect(rows.map((r) => r.key)).not.toContain("old-0");
  });

  it("ties keep the API's order; an unreadable time sinks to the end", () => {
    const a = item({ unlockId: "a" });
    const b = item({ unlockId: "b" });
    const broken = item({ unlockId: "broken", grantedAt: "soon" });
    expect(recentUnlockRows([broken, a, b], NOW).map((r) => r.key)).toEqual(["a", "b", "broken"]);
  });
});

describe("isoDay", () => {
  it("is the UTC calendar day; an unreadable value passes through", () => {
    expect(isoDay("2026-10-05T23:59:59.000Z")).toBe("2026-10-05");
    expect(isoDay("soon")).toBe("soon");
  });
});
