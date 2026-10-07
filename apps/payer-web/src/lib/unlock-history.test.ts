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
 * The payer's own unlock history, read for two screens: which applicant rows start unlocked
 * (F10) and what a dashboard Recent-unlocks row says (F37). Pure; a fixed `now`. Fixtures mirror
 * the wire as getUnlocks maps it: `jobPostingId` is null unless the unlock was made from a company
 * posting (#2033); an agency unlock's `jobs` id is not carried.
 */

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const W1 = "33333333-0000-4000-8000-000000000001";
const W2 = "33333333-0000-4000-8000-000000000002";
const W3 = "33333333-0000-4000-8000-000000000003";
/** This payer's own company postings, as the dashboard read them. */
const P1 = "55555555-0000-4000-8000-000000000001";
const P2 = "55555555-0000-4000-8000-000000000002";
const OWN = [
  { id: P1, roleTitle: "CNC Operator" },
  { id: P2, roleTitle: "VMC Setter" },
];
/** A real posting id that is NOT in this payer's list (another payer's, or one not read). */
const FOREIGN = "55555555-0000-4000-8000-0000000000ff";

const item = (over: Partial<UnlockHistoryItem> = {}): UnlockHistoryItem => ({
  unlockId: "44444444-0000-4000-8000-000000000001",
  workerId: W1,
  status: "granted",
  createdAt: "2026-10-01T09:00:00.000Z",
  expiresAt: "2026-10-15T09:00:00.000Z",
  grantedAt: "2026-10-01T09:00:00.000Z",
  jobPostingId: null,
  ...over,
});

describe("isLiveUnlock — granted AND the window still open", () => {
  it("a granted record whose window ends later is live", () => {
    expect(isLiveUnlock(item(), NOW)).toBe(true);
  });

  it("a record whose window has ENDED is not live, even though its stored status still says granted", () => {
    // The server derives `expired` at ITS read; a row it still sent as granted can lapse before
    // the page renders (or under clock skew) — the window end at `now` decides.
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
    // A company unlock now records the posting it was made from (#2033), but the grant is the
    // worker's (ADR-0010 sign-off 1): that context never ties it to one feed.
    const history = [item({ unlockId: "u-1", workerId: W1, jobPostingId: P1 })];
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
      OWN,
      NOW,
    );
    expect(row.unlockedOn).toBe("2026-10-01");
    expect(row.endsOn).toBe("2026-10-15");
    // No grant time on the record → its creation day.
    expect(unlockRow(item({ grantedAt: null }), OWN, NOW).unlockedOn).toBe("2026-10-01");
  });

  it("live vs ended follows isLiveUnlock (a lapsed 'granted' row reads ended)", () => {
    expect(unlockRow(item(), OWN, NOW).live).toBe(true);
    expect(unlockRow(item({ expiresAt: "2026-09-01T00:00:00.000Z" }), OWN, NOW).live).toBe(false);
    expect(unlockRow(item({ status: "expired" }), OWN, NOW).live).toBe(false);
  });

  it("carries exactly its key, status, days and posting — no worker id; no context names no posting", () => {
    const row = unlockRow(item(), OWN, NOW);
    expect(Object.keys(row).sort()).toEqual(["endsOn", "key", "live", "posting", "unlockedOn"]);
    expect(row.posting).toBeNull();
    expect(JSON.stringify(row)).not.toContain(W1);
  });

  it("#2033: names its posting when the unlock was made from one of the payer's OWN postings", () => {
    expect(unlockRow(item({ jobPostingId: P2 }), OWN, NOW).posting).toEqual({
      id: P2,
      title: "VMC Setter",
    });
  });

  it("#2033: an id NOT in the payer's own list is never resolved — no title, no id carried", () => {
    // Another payer's posting (or one this page did not read) must not lend the row a title.
    const foreign = unlockRow(item({ jobPostingId: FOREIGN }), OWN, NOW);
    expect(foreign.posting).toBeNull();
    expect(JSON.stringify(foreign)).not.toContain(FOREIGN);
    // No list read (an agency session, or a failed postings read): even an own id names nothing.
    expect(unlockRow(item({ jobPostingId: P1 }), [], NOW).posting).toBeNull();
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
    const rows = recentUnlockRows([fresh, regrant], OWN, NOW);
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
    const rows = recentUnlockRows([...older.reverse(), regrant], OWN, NOW);
    expect(rows).toHaveLength(5);
    expect(rows[0]!.key).toBe("regrant");
    expect(rows.map((r) => r.key)).not.toContain("old-0");
  });

  it("#2033: each row names its OWN posting, resolved against the list it is given", () => {
    const rows = recentUnlockRows(
      [
        item({ unlockId: "from-p1", grantedAt: "2026-10-03T09:00:00.000Z", jobPostingId: P1 }),
        item({ unlockId: "foreign", grantedAt: "2026-10-02T09:00:00.000Z", jobPostingId: FOREIGN }),
        item({ unlockId: "search", grantedAt: "2026-10-01T09:00:00.000Z" }),
      ],
      OWN,
      NOW,
    );
    expect(rows.map((r) => [r.key, r.posting?.title ?? null])).toEqual([
      ["from-p1", "CNC Operator"],
      ["foreign", null],
      ["search", null],
    ]);
  });

  it("ties keep the API's order; an unreadable time sinks to the end", () => {
    const a = item({ unlockId: "a" });
    const b = item({ unlockId: "b" });
    const broken = item({ unlockId: "broken", grantedAt: "soon" });
    expect(recentUnlockRows([broken, a, b], OWN, NOW).map((r) => r.key)).toEqual([
      "a",
      "b",
      "broken",
    ]);
  });
});

describe("isoDay", () => {
  it("is the UTC calendar day; an unreadable value passes through", () => {
    expect(isoDay("2026-10-05T23:59:59.000Z")).toBe("2026-10-05");
    expect(isoDay("soon")).toBe("soon");
  });
});
