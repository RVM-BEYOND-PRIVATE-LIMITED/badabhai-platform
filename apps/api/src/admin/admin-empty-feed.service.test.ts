import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { AdminEmptyFeedService } from "./admin-empty-feed.service";
import type { AdminEmptyFeedRepository } from "./admin-empty-feed.repository";
import type { AdminEmptyFeedQueryDto } from "./admin-empty-feed.dto";
import { AdminEmptyFeedQuerySchema } from "./admin-empty-feed.dto";

/**
 * #2569 — feed-mode precedence, label mapping and the page envelope. The SQL itself is pinned
 * by `admin-empty-feed.contract.test.ts` and exercised against Postgres in the DB test.
 */
function repo(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    page: vi.fn(async () => ({
      workers: [
        {
          worker_id: "w1",
          trade_id: "role_cnc_operator",
          city: "Pune",
          profile_status: "confirmed",
          days_since_signup: 12,
        },
        {
          worker_id: "w2",
          trade_id: null,
          city: null,
          profile_status: null,
          days_since_signup: 0,
        },
      ],
      byTrade: [
        { trade_id: "role_cnc_operator", worker_count: 3 },
        { trade_id: null, worker_count: 2 },
      ],
      byCity: [
        { city: "Pune", worker_count: 4 },
        { city: null, worker_count: 1 },
      ],
      ...overrides,
    })),
  };
}

function service(r: ReturnType<typeof repo>, config: Partial<ServerConfig> = {}) {
  return new AdminEmptyFeedService(
    r as unknown as AdminEmptyFeedRepository,
    config as ServerConfig,
  );
}

const QUERY: AdminEmptyFeedQueryDto = AdminEmptyFeedQuerySchema.parse({});

describe("#2569 AdminEmptyFeedService", () => {
  it("maps the faceless rows, labels the trade, and sums the total from the trade buckets", async () => {
    const r = repo();
    const page = await service(r).list({ ...QUERY, page: 2, page_size: 2 });

    expect(r.page).toHaveBeenCalledWith({
      mode: "jobs",
      includeTestAccounts: false,
      page: 2,
      pageSize: 2,
    });
    expect(page.workers).toEqual([
      {
        worker_id: "w1",
        trade_id: "role_cnc_operator",
        trade_name: "CNC Operator",
        city: "Pune",
        profile_status: "confirmed",
        days_since_signup: 12,
      },
      {
        worker_id: "w2",
        trade_id: null,
        trade_name: null,
        city: null,
        profile_status: null,
        days_since_signup: 0,
      },
    ]);
    // byTrade covers EVERY row (including the null bucket), so 3 + 2 is the exact total.
    expect(page.total).toBe(5);
    expect(page.total_pages).toBe(3);
    expect(page.counts.by_trade).toEqual([
      { trade_id: "role_cnc_operator", trade_name: "CNC Operator", count: 3 },
      { trade_id: null, trade_name: null, count: 2 },
    ]);
    expect(page.counts.by_city).toEqual([
      { city: "Pune", count: 4 },
      { city: null, count: 1 },
    ]);
    expect(page.feed_mode).toBe("jobs");
  });

  it("resolves the SAME precedence the feed does: V1, then union, then legacy jobs", () => {
    expect(AdminEmptyFeedService.feedMode({ MATCH_V1_ENABLED: true } as ServerConfig)).toBe("v1");
    expect(
      AdminEmptyFeedService.feedMode({
        MATCH_V1_ENABLED: false,
        FEED_POSTINGS_UNION_ENABLED: true,
      } as ServerConfig),
    ).toBe("union");
    expect(
      AdminEmptyFeedService.feedMode({
        MATCH_V1_ENABLED: false,
        FEED_POSTINGS_UNION_ENABLED: false,
      } as ServerConfig),
    ).toBe("jobs");
  });

  it("a zero-row page is honest: total 0 and total_pages 0", async () => {
    const r = repo({ workers: [], byTrade: [], byCity: [] });
    const page = await service(r).list(QUERY);
    expect(page.total).toBe(0);
    expect(page.total_pages).toBe(0);
    expect(page.workers).toEqual([]);
    expect(page.counts).toEqual({ by_trade: [], by_city: [] });
  });

  it("the query schema excludes test accounts by default and parses the string pair correctly", () => {
    expect(AdminEmptyFeedQuerySchema.parse({}).include_test_accounts).toBe(false);
    expect(
      AdminEmptyFeedQuerySchema.parse({ include_test_accounts: "false" }).include_test_accounts,
    ).toBe(false);
    expect(
      AdminEmptyFeedQuerySchema.parse({ include_test_accounts: "true" }).include_test_accounts,
    ).toBe(true);
    // The page ceiling is a hard cap, not a silent clamp.
    expect(() => AdminEmptyFeedQuerySchema.parse({ page_size: "101" })).toThrow();
    expect(AdminEmptyFeedQuerySchema.parse({ page_size: "100" }).page_size).toBe(100);
  });
});
