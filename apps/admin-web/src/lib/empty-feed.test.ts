import { describe, expect, it } from "vitest";

import {
  describeEmptyFeedBucket,
  describeEmptyFeedWorker,
  emptyFeedPageSchema,
} from "./empty-feed";

/**
 * B15 (#2569) — the portal-side mirror of `GET /admin/workers/empty-feed`.
 *
 * WHAT THIS PINS. The server owns the contract
 * (`apps/api/src/admin/admin-empty-feed.dto.ts`); this file re-states it in zod. A field
 * the server adds must appear here the day it ships — and a field this file requires
 * that the server drops fails the read closed instead of rendering half a list.
 */

const WIRE = {
  workers: [
    {
      worker_id: "11111111-1111-4111-8111-111111111111",
      trade_id: "role_welder",
      trade_name: "Welder",
      city: "Pune",
      profile_status: "confirmed",
      days_since_signup: 9,
    },
    {
      worker_id: "22222222-2222-4222-8222-222222222222",
      trade_id: null,
      trade_name: null,
      city: null,
      profile_status: null,
      days_since_signup: 0,
    },
  ],
  page: 1,
  page_size: 50,
  total: 2,
  total_pages: 1,
  feed_mode: "union",
  counts: {
    by_trade: [{ trade_id: "role_welder", trade_name: "Welder", count: 1 }],
    by_city: [{ city: "Pune", count: 1 }],
  },
};

describe("empty-feed wire contract", () => {
  it("parses a captured status payload through the REAL schema", () => {
    expect(emptyFeedPageSchema.parse(WIRE)).toEqual(WIRE);
  });

  it("a trade the portal has never heard of still parses (open vocabularies, never enums)", () => {
    const unknown = {
      ...WIRE,
      workers: [{ ...WIRE.workers[0]!, trade_id: "role_futuristic", trade_name: "Futuristic" }],
    };
    expect(emptyFeedPageSchema.parse(unknown).workers[0]!.trade_id).toBe("role_futuristic");
  });
});

describe("describeEmptyFeedWorker", () => {
  it("names the trade, city, age and the echoed feed mode", () => {
    expect(
      describeEmptyFeedWorker(
        { trade_name: "Welder", city: "Pune", days_since_signup: 9 },
        "union",
      ),
    ).toBe("Welder · Pune · signed up 9 days ago (feed: union).");
  });

  it("unstated trade/city read as unstated, never blank", () => {
    expect(
      describeEmptyFeedWorker({ trade_name: null, city: null, days_since_signup: 0 }, "v1"),
    ).toBe("no trade yet · no city stated · signed up today (feed: v1).");
  });
});

describe("describeEmptyFeedBucket", () => {
  it("a null label says not stated, never blank", () => {
    expect(describeEmptyFeedBucket({ count: 3 }, null)).toBe("Not stated: 3 workers.");
  });

  it("a stated label states its count", () => {
    expect(describeEmptyFeedBucket({ count: 9 }, "Pune")).toBe("Pune: 9 workers.");
  });
});
