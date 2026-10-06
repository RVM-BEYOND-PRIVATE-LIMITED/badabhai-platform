import { describe, expect, it } from "vitest";
import type { UnlockHistoryItem } from "./contracts";
import { isLiveUnlock, isoDay, liveUnlocksFor, unlockRow } from "./unlock-history";

/**
 * The payer's own unlock history, read for two screens: which applicant rows start unlocked
 * (F10) and what a dashboard Recent-unlocks row says (F37). Pure; a fixed `now`.
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
  jobId: null,
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

  it("matches on the worker alone — the job context (null for a company unlock) never decides", () => {
    const out = liveUnlocksFor(
      [item({ workerId: W1, jobId: null }), item({ unlockId: "u-2", workerId: W2, jobId: W3 })],
      [W1, W2],
      NOW,
    );
    expect(Object.keys(out).sort()).toEqual([W1, W2]);
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
  const POSTINGS = [{ id: "p-1", roleTitle: "CNC Turner" }];

  it("names the posting only when the record's context is one of the payer's own postings", () => {
    expect(unlockRow(item({ jobId: "p-1" }), POSTINGS, NOW).posting).toEqual({
      id: "p-1",
      title: "CNC Turner",
    });
    // A company unlock is stored with no context; an agency `jobs` id is not a company posting.
    expect(unlockRow(item({ jobId: null }), POSTINGS, NOW).posting).toBeNull();
    expect(unlockRow(item({ jobId: "j-9" }), POSTINGS, NOW).posting).toBeNull();
    expect(unlockRow(item({ jobId: undefined }), POSTINGS, NOW).posting).toBeNull();
  });

  it("dates: unlocked on the GRANT day (a re-grant moves it), ends on the window end", () => {
    const row = unlockRow(
      item({ createdAt: "2026-08-01T09:00:00.000Z", grantedAt: "2026-10-01T23:30:00.000Z" }),
      [],
      NOW,
    );
    expect(row.unlockedOn).toBe("2026-10-01");
    expect(row.endsOn).toBe("2026-10-15");
    // No grant time on the record → its creation day.
    expect(unlockRow(item({ grantedAt: null }), [], NOW).unlockedOn).toBe("2026-10-01");
  });

  it("live vs ended follows isLiveUnlock (a lapsed 'granted' row reads ended)", () => {
    expect(unlockRow(item(), [], NOW).live).toBe(true);
    expect(unlockRow(item({ expiresAt: "2026-09-01T00:00:00.000Z" }), [], NOW).live).toBe(false);
    expect(unlockRow(item({ status: "expired" }), [], NOW).live).toBe(false);
  });

  it("carries no worker id (the dashboard is faceless)", () => {
    expect(JSON.stringify(unlockRow(item({ jobId: "p-1" }), POSTINGS, NOW))).not.toContain(W1);
  });
});

describe("isoDay", () => {
  it("is the UTC calendar day; an unreadable value passes through", () => {
    expect(isoDay("2026-10-05T23:59:59.000Z")).toBe("2026-10-05");
    expect(isoDay("soon")).toBe("soon");
  });
});
