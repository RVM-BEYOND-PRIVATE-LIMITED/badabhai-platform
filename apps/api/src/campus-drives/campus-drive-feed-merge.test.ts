import { describe, expect, it } from "vitest";
import { mergeDriveFeed } from "./campus-drive-feed-merge";

/**
 * #2811 — the merge of Campus's two feed sources (requests by `updated_at`, erasures of deleted
 * requests by `erased_at`) into one page under one cursor. Pure: no database.
 */

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const t = (micros: number) => `2026-11-20T06:00:00.${String(micros).padStart(6, "0")}Z`;
const req = (n: number, at: number) => ({ id: id(n), changedKey: t(at) });
const gone = (n: number, at: number) => ({ id: id(n), erasedKey: t(at) });

describe("mergeDriveFeed", () => {
  it("interleaves the two sources by time, then splits them back, each in order", () => {
    const out = mergeDriveFeed([req(1, 10), req(2, 30), req(3, 50)], [gone(9, 20), gone(8, 40)], 10);
    expect(out.requests.map((r) => r.id)).toEqual([id(1), id(2), id(3)]);
    expect(out.erasures.map((e) => e.id)).toEqual([id(9), id(8)]);
    expect(out.last).toEqual({ at: t(50), id: id(3) });
    expect(out.hasMore).toBe(false);
  });

  it("takes the first `limit` of the MERGED stream and mints the cursor from the last entry taken, whatever its kind", () => {
    const out = mergeDriveFeed([req(1, 10), req(2, 30), req(3, 50)], [gone(9, 20), gone(8, 40)], 3);
    expect(out.requests.map((r) => r.id)).toEqual([id(1), id(2)]);
    expect(out.erasures.map((e) => e.id)).toEqual([id(9)]);
    expect(out.last).toEqual({ at: t(30), id: id(2) });
    expect(out.hasMore).toBe(true);

    const atErasure = mergeDriveFeed([req(1, 10), req(2, 30)], [gone(9, 20), gone(8, 40)], 2);
    expect(atErasure.last).toEqual({ at: t(20), id: id(9) });
    expect(atErasure.hasMore).toBe(true);
  });

  it("at the same instant, the id decides (as the SQL keyset does)", () => {
    const out = mergeDriveFeed([req(5, 10)], [gone(4, 10), gone(6, 10)], 2);
    expect(out.erasures.map((e) => e.id)).toEqual([id(4)]);
    expect(out.requests.map((r) => r.id)).toEqual([id(5)]);
    expect(out.last).toEqual({ at: t(10), id: id(5) });
    expect(out.hasMore).toBe(true);
  });

  it("hasMore when EITHER source had a row past the page (each was read with limit + 1)", () => {
    // Requests alone overflow.
    expect(mergeDriveFeed([req(1, 1), req(2, 2), req(3, 3)], [], 2).hasMore).toBe(true);
    // Erasures alone overflow.
    expect(mergeDriveFeed([], [gone(1, 1), gone(2, 2), gone(3, 3)], 2).hasMore).toBe(true);
    // Each under the limit, but together over it.
    expect(mergeDriveFeed([req(1, 1)], [gone(2, 2), gone(3, 3)], 2).hasMore).toBe(true);
    // Exactly the limit: no more.
    expect(mergeDriveFeed([req(1, 1)], [gone(2, 2)], 2).hasMore).toBe(false);
  });

  it("an empty feed has no last position and no more", () => {
    expect(mergeDriveFeed([], [], 5)).toEqual({
      requests: [],
      erasures: [],
      last: undefined,
      hasMore: false,
    });
  });

  it("pages the whole stream with no entry skipped or repeated, at every page size", () => {
    const requests = [req(1, 3), req(2, 3), req(3, 7), req(4, 12), req(5, 12)];
    const erasures = [gone(10, 1), gone(11, 3), gone(12, 9), gone(13, 12), gone(14, 20)];
    const key = (e: { id: string; changedKey?: string; erasedKey?: string }) =>
      `${e.changedKey ?? e.erasedKey}|${e.id}`;
    const whole = [...requests, ...erasures].map(key).sort();
    for (let limit = 1; limit <= 11; limit++) {
      const served: string[] = [];
      let after: { at: string; id: string } | undefined;
      for (let guard = 0; guard < 20; guard++) {
        // What each SQL read returns after the cursor: its own order, limit + 1 rows.
        const past = (k: string) => after === undefined || k > `${after.at}|${after.id}`;
        const r = requests.filter((x) => past(key(x))).slice(0, limit + 1);
        const e = erasures.filter((x) => past(key(x))).slice(0, limit + 1);
        const page = mergeDriveFeed(r, e, limit);
        served.push(...page.requests.map(key), ...page.erasures.map(key));
        if (!page.hasMore) break;
        after = page.last;
      }
      expect(served.sort(), `limit ${limit}`).toEqual(whole);
    }
  });
});
