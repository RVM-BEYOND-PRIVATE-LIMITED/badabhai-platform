import { Logger } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@badabhai/db";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { AgencyWorkersRepository } from "./agency-workers.repository";

/**
 * #2753 — the agency list's switched-on order names `worker_activity` directly (the LIMIT's
 * membership), so it carries the same fallback as `lastActiveDays`: WORKER_ACTIVITY_ENABLED on
 * before migration 0168 (42P01) orders by the device day alone, today's statement, and never
 * answers 500. Any other error, and any error with the switch off, still throws. The SQL itself is
 * proven against a real Postgres in `worker-activity.db.test.ts`.
 */
const TENANT = "aaaaaaaa-0000-4000-8000-00000000000a" as TenantKey;
const W1 = "11111111-1111-4111-8111-111111111111";
const ROW = {
  worker_id: W1,
  profile_complete: true,
  applied_count: "2",
  unlocked_count: "0",
  last_active_on: "2026-11-01",
};
const dialect = new PgDialect();
const textOf = (query: SQL) => dialect.sqlToQuery(query).sql;
const failure = (code: string) =>
  Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("x"), { code }) });

function fakeDb() {
  const execute = vi.fn<(query: SQL) => Promise<unknown>>();
  return { db: { execute } as unknown as Database, execute };
}

afterEach(() => vi.restoreAllMocks());

describe("AgencyWorkersRepository — the switched-on order without worker_activity", () => {
  it("42P01 with activityOrder: one retry with today's order, the rows returned, one warning", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const f = fakeDb();
    f.execute.mockRejectedValueOnce(failure("42P01")).mockResolvedValueOnce([ROW]);
    const rows = await new AgencyWorkersRepository(f.db).listReferredWithConsent(TENANT, 200, {
      activityOrder: true,
    });
    expect(rows).toEqual([
      {
        workerId: W1,
        profileComplete: true,
        appliedCount: 2,
        unlockedCount: 0,
        lastActiveOn: "2026-11-01",
      },
    ]);
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(textOf(f.execute.mock.calls[0]![0])).toContain("worker_activity");
    expect(textOf(f.execute.mock.calls[1]![0])).not.toContain("worker_activity");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("0168_worker_activity");
  });

  it("the fallback statement is the switch-off statement, byte for byte", async () => {
    const off = fakeDb();
    off.execute.mockResolvedValue([]);
    await new AgencyWorkersRepository(off.db).listReferredWithConsent(TENANT, 200);

    const on = fakeDb();
    on.execute.mockRejectedValueOnce(failure("42P01")).mockResolvedValueOnce([]);
    await new AgencyWorkersRepository(on.db).listReferredWithConsent(TENANT, 200, {
      activityOrder: true,
    });
    expect(textOf(on.execute.mock.calls[1]![0])).toBe(textOf(off.execute.mock.calls[0]![0]));
  });

  it.each([["57P01"], ["42703"], ["42501"]])(
    "another SQLSTATE (%s) with activityOrder still throws, with no retry",
    async (code) => {
      const f = fakeDb();
      f.execute.mockRejectedValue(failure(code));
      await expect(
        new AgencyWorkersRepository(f.db).listReferredWithConsent(TENANT, 200, {
          activityOrder: true,
        }),
      ).rejects.toMatchObject({ cause: { code } });
      expect(f.execute).toHaveBeenCalledTimes(1);
    },
  );

  it("switch off: a 42P01 is some other table (the statement never names worker_activity), so it throws", async () => {
    const f = fakeDb();
    f.execute.mockRejectedValue(failure("42P01"));
    await expect(
      new AgencyWorkersRepository(f.db).listReferredWithConsent(TENANT, 200),
    ).rejects.toMatchObject({ cause: { code: "42P01" } });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
});
