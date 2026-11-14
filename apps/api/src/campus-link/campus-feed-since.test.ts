import { describe, expect, it } from "vitest";
import { CAMPUS_EARLIEST_DECISION_TIME } from "./campus-link.contract";
import { CAMPUS_FEED_OVERLAP_MS, feedChangedSince } from "./campus-postings.service";

/**
 * #2752 Part E — where a Campus feed read with `changed_since` starts (both feeds share it). The
 * schema accepts a year-0000 time, which Postgres's `timestamptz` cast refuses (22008, a 500), so
 * the start is clamped to the earliest Campus time; nothing the link records is older.
 */
describe("feedChangedSince", () => {
  it("reaches back the overlap before Campus's mark", () => {
    const mark = "2026-11-14T10:00:00.000Z";
    expect(feedChangedSince(mark).getTime()).toBe(Date.parse(mark) - CAMPUS_FEED_OVERLAP_MS);
    expect(feedChangedSince("2026-11-14T15:30:00.000+05:30").toISOString()).toBe(
      "2026-11-14T09:58:00.000Z",
    );
  });

  it("never starts before CAMPUS_EARLIEST_DECISION_TIME (a year-0000 mark would be a 500)", () => {
    expect(feedChangedSince("0000-01-01T00:00:00.000Z").toISOString()).toBe(
      CAMPUS_EARLIEST_DECISION_TIME,
    );
    expect(feedChangedSince("2025-06-01T00:00:00.000Z").toISOString()).toBe(
      CAMPUS_EARLIEST_DECISION_TIME,
    );
    // The overlap alone never takes a mark just after the earliest time below it.
    expect(feedChangedSince("2026-01-01T00:01:00.000Z").toISOString()).toBe(
      CAMPUS_EARLIEST_DECISION_TIME,
    );
  });
});
