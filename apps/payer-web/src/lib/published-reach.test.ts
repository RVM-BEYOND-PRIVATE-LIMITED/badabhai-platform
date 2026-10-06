import { describe, expect, it } from "vitest";
import { parsePublishedReach, publishedReachMessage, withPublishedReach } from "./published-reach";

describe("published reach — the ?reached=N hand-off", () => {
  it("attaches a whole count and leaves the path alone without one", () => {
    expect(withPublishedReach("/postings/p1/applicants", 12)).toBe("/postings/p1/applicants?reached=12");
    expect(withPublishedReach("/postings/p1", 0)).toBe("/postings/p1?reached=0");
    expect(withPublishedReach("/postings/p1?x=1", 3)).toBe("/postings/p1?x=1&reached=3");
    for (const none of [null, undefined, -1, 1.5, Number.NaN]) {
      expect(withPublishedReach("/postings/p1", none)).toBe("/postings/p1");
    }
  });

  it("parses only a whole number ≥ 0 — anything else shows nothing, never a guess", () => {
    expect(parsePublishedReach("42")).toBe(42);
    expect(parsePublishedReach("0")).toBe(0);
    expect(parsePublishedReach(["7", "9"])).toBe(7);
    for (const bad of [undefined, "", "-1", "1.5", "12abc", "1e3", "9999999999"]) {
      expect(parsePublishedReach(bad)).toBeNull();
    }
  });

  it("reads 'Reached N workers', singular for one", () => {
    expect(publishedReachMessage(1)).toBe("Reached 1 worker");
    expect(publishedReachMessage(12)).toBe("Reached 12 workers");
    expect(publishedReachMessage(1500)).toBe("Reached 1,500 workers");
  });
});
