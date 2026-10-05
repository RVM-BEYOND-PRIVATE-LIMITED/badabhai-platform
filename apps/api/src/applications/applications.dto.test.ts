import { describe, it, expect } from "vitest";
import { FEED_PAY_MIN_MAX, FeedQuerySchema } from "./applications.dto";

/**
 * Locks the LIBERAL-feed contract at the schema boundary (the headline of the
 * "honest liberal feed" change): a no-`limit` request must default to the full
 * generous page, and the page must stay bounded. Without these, a silent revert
 * of the default (→ 20) or a lowered cap would pass every other suite green.
 */
describe("FeedQuerySchema (liberal, bounded page)", () => {
  it("defaults to 50 when no limit is given — a no-limit /feed returns ALL open jobs (early on)", () => {
    expect(FeedQuerySchema.parse({}).limit).toBe(50);
  });

  it("accepts the cap (50) and a smaller page", () => {
    expect(FeedQuerySchema.parse({ limit: 50 }).limit).toBe(50);
    expect(FeedQuerySchema.parse({ limit: 10 }).limit).toBe(10);
  });

  it("stays BOUNDED — rejects above the cap (never an unbounded page)", () => {
    expect(() => FeedQuerySchema.parse({ limit: 51 })).toThrow();
  });

  it("rejects a non-positive limit", () => {
    expect(() => FeedQuerySchema.parse({ limit: 0 })).toThrow();
  });

  it("coerces a numeric string (query params arrive as strings)", () => {
    expect(FeedQuerySchema.parse({ limit: "30" }).limit).toBe(30);
  });
});

describe("FeedQuerySchema pay_min (#1905: bounded to the column type)", () => {
  it("accepts a floor up to the int4 max that `pay_max` is compared against", () => {
    expect(FeedQuerySchema.parse({ pay_min: "20000" }).pay_min).toBe(20000);
    expect(FeedQuerySchema.parse({ pay_min: String(FEED_PAY_MIN_MAX) }).pay_min).toBe(FEED_PAY_MIN_MAX);
  });

  it.each(["2147483648", "1e10", "9007199254740991"])(
    "rejects pay_min=%s at the boundary (400), never a 500 from an out-of-range bind",
    (value) => {
      expect(FeedQuerySchema.safeParse({ pay_min: value }).success).toBe(false);
    },
  );
});
