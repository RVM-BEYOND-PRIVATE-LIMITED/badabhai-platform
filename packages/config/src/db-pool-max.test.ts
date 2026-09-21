import { describe, it, expect } from "vitest";
import {
  resolveDbPoolMax,
  DEV_DB_POOL_MAX,
  PROD_DB_POOL_MAX,
  type ServerConfig,
} from "./server";

/**
 * The pool size shared-pooler rule.
 *
 * `createDbClient` hardcoded `max: 10`. Against a SHARED Supabase pooler — session mode, 15
 * clients TOTAL across every process aimed at it — one developer's API claimed two-thirds of
 * the team's budget. And the resulting failure is a hard one: postgres.js opens a new
 * connection when its pool has none free, and a refusal REJECTS THE QUERY rather than waiting
 * on one of its own idle connections, so writes fail while usable idle connections are held.
 * Transactional writes break first (`sql.begin` holds a connection for the whole transaction),
 * which is exactly how the admin-invite 500 presented while plain reads kept working.
 */

function cfg(over: Partial<ServerConfig>): ServerConfig {
  return { NODE_ENV: "development", ...over } as ServerConfig;
}

describe("resolveDbPoolMax — an explicit value always wins", () => {
  it("uses DB_POOL_MAX when set, in every environment", () => {
    for (const env of ["development", "test", "staging", "production"] as const) {
      expect(resolveDbPoolMax(cfg({ NODE_ENV: env, DB_POOL_MAX: 7 }))).toBe(7);
    }
  });

  it("honours a deliberately tiny pool (1) rather than substituting a default", () => {
    // 1 is a legitimate choice on a saturated pooler; it must not be treated as unset.
    expect(resolveDbPoolMax(cfg({ DB_POOL_MAX: 1 }))).toBe(1);
  });
});

describe("resolveDbPoolMax — the default depends on who owns the database", () => {
  it("production gets the full pool (it owns its connections)", () => {
    expect(resolveDbPoolMax(cfg({ NODE_ENV: "production" }))).toBe(PROD_DB_POOL_MAX);
  });

  it("every NON-production environment gets the small shared-pooler slice", () => {
    for (const env of ["development", "test", "staging"] as const) {
      expect(resolveDbPoolMax(cfg({ NODE_ENV: env }))).toBe(DEV_DB_POOL_MAX);
    }
  });

  it("the dev default leaves room for teammates on a 15-client pooler", () => {
    // The property that matters is not the exact number but that several developers plus the
    // deployed services fit inside one pooler at once.
    expect(DEV_DB_POOL_MAX).toBeLessThan(PROD_DB_POOL_MAX);
    expect(DEV_DB_POOL_MAX * 4).toBeLessThanOrEqual(15);
  });

  it("never returns a non-positive pool (0 would deadlock every query)", () => {
    for (const env of ["development", "test", "staging", "production"] as const) {
      expect(resolveDbPoolMax(cfg({ NODE_ENV: env }))).toBeGreaterThan(0);
    }
  });
});
