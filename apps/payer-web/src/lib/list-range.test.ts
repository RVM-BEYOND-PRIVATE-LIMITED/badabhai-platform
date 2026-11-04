import { describe, expect, it } from "vitest";
import { FROM_PARAM, listRange, nextStart, pageStart, rangeLabel } from "./list-range";

/**
 * #2588 — where a page of a keyset-paged list starts, and what the pager says about it. The cursor
 * is the server's (never read here), so the start is the portal's own count, carried by "Next page".
 */
const CURSOR = "eyJ2IjoxLCJwIjoxfQ";

describe("pageStart — 1 on the first page; the pager's `from` on a later one", () => {
  it("the first page (no cursor) starts at 1, whatever the address says", () => {
    expect(pageStart(undefined, null)).toBe(1);
    expect(pageStart("41", null)).toBe(1);
  });

  it("a later page starts where the pager said", () => {
    expect(FROM_PARAM).toBe("from");
    expect(pageStart("21", CURSOR)).toBe(21);
    expect(pageStart("2", CURSOR)).toBe(2);
  });

  it("anything else is unknown — never a guess", () => {
    for (const raw of [undefined, "", "1", "0", "-21", "21.5", "2e3", " 21", "021", "abc", "99999999"]) {
      expect(pageStart(raw, CURSOR), String(raw)).toBeNull();
    }
    expect(pageStart(["21", "41"], CURSOR)).toBeNull();
  });
});

describe("listRange + rangeLabel — 'Showing 21–40 of 57'", () => {
  it("the rows a page shows, of the list's size", () => {
    const r = listRange(21, 20, 57);
    expect(r).toEqual({ first: 21, last: 40, total: 57 });
    expect(rangeLabel(r!)).toBe("Showing 21–40 of 57");
    expect(nextStart(r!)).toBe(41);
  });

  it("the first page, the last (short) page, and a one-row page", () => {
    expect(rangeLabel(listRange(1, 20, 57)!)).toBe("Showing 1–20 of 57");
    expect(rangeLabel(listRange(41, 17, 57)!)).toBe("Showing 41–57 of 57");
    expect(rangeLabel(listRange(57, 1, 57)!)).toBe("Showing 57 of 57");
  });

  it("with no total (the API does not say one), the range alone", () => {
    expect(rangeLabel(listRange(21, 20, null)!)).toBe("Showing 21–40");
    expect(nextStart(listRange(21, 20, null)!)).toBe(41);
  });

  it("no range for an unknown start, an empty page, or one that runs past the list (a stale link)", () => {
    expect(listRange(null, 20, 57)).toBeNull();
    expect(listRange(21, 0, 57)).toBeNull();
    expect(listRange(41, 20, 57)).toBeNull();
  });
});
