import { describe, expect, it } from "vitest";
import { lastPage, pageRange, pageWindow } from "./pagination";

/**
 * The numbered pager's arithmetic (A4, #2574): "1–50 of 24,310 · ‹ 1 2 3 … 487 ›". Only a list
 * whose API answers an exact total pages by number (the data-bank tabs, #2577–#2579).
 */
describe("lastPage", () => {
  it("is the page that holds the last row", () => {
    expect(lastPage(50, 24_310)).toBe(487);
    expect(lastPage(50, 50)).toBe(1);
    expect(lastPage(50, 51)).toBe(2);
  });

  it("is 1 for an empty list or a nonsense size — a pager never points at page 0", () => {
    expect(lastPage(50, 0)).toBe(1);
    expect(lastPage(0, 100)).toBe(1);
    expect(lastPage(Number.NaN, 100)).toBe(1);
  });
});

describe("pageRange", () => {
  it("names the 1-based rows on a page, both ends inclusive", () => {
    expect(pageRange(1, 50, 24_310)).toEqual({ from: 1, to: 50 });
    expect(pageRange(2, 50, 24_310)).toEqual({ from: 51, to: 100 });
  });

  it("stops at the last row on the last page", () => {
    expect(pageRange(487, 50, 24_310)).toEqual({ from: 24_301, to: 24_310 });
  });

  it("is null where the page holds nothing — never '51–50'", () => {
    expect(pageRange(2, 50, 50)).toBeNull();
    expect(pageRange(1, 50, 0)).toBeNull();
    expect(pageRange(0, 50, 10)).toBeNull();
  });
});

describe("pageWindow", () => {
  it("opens on the brief's own shape: 1 2 3 … last", () => {
    expect(pageWindow(1, 487)).toEqual([1, 2, 3, "gap", 487]);
    expect(pageWindow(2, 487)).toEqual([1, 2, 3, "gap", 487]);
  });

  it("keeps the first, the last, and the current page with one each side", () => {
    expect(pageWindow(10, 487)).toEqual([1, "gap", 9, 10, 11, "gap", 487]);
    expect(pageWindow(487, 487)).toEqual([1, "gap", 485, 486, 487]);
  });

  it("never puts an ellipsis where it would stand for ONE page", () => {
    // Page 4: the run between 1 and 3 is just page 2 — shown, not "…".
    expect(pageWindow(4, 487)).toEqual([1, 2, 3, 4, 5, "gap", 487]);
    expect(pageWindow(1, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("is every page when there are few", () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(2, 3)).toEqual([1, 2, 3]);
  });

  it("clamps a stale page past the end, so the pager still leads back into the list", () => {
    expect(pageWindow(600, 487)).toEqual(pageWindow(487, 487));
    expect(pageWindow(0, 487)).toEqual(pageWindow(1, 487));
  });

  it("never repeats a page and is always ascending", () => {
    for (let last = 1; last <= 30; last++) {
      for (let page = 1; page <= last; page++) {
        const pages = pageWindow(page, last).filter((s): s is number => s !== "gap");
        expect(new Set(pages).size, `${page}/${last}`).toBe(pages.length);
        expect([...pages].sort((a, b) => a - b), `${page}/${last}`).toEqual(pages);
        expect(pages, `${page}/${last}`).toContain(page);
        expect(pages[0]).toBe(1);
        expect(pages.at(-1)).toBe(last);
      }
    }
  });
});
