import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQL, is } from "drizzle-orm";
import { PinRepository } from "./pin.repository";

/**
 * DB-free unit of the ONE security-critical write in this repo: recordFailureEscalation must
 * mirror the two force-OTP latches (lockout_cycles, otp_cycle_count) MONOTONICALLY —
 * `GREATEST(current, value)` — never as a blind absolute number. A blind write lets a lagging
 * multi-device escalation clobber a concurrently-raised latch and defeat the OTP cap (F1). The
 * pin.service concurrency test proves the state machine survives GIVEN this contract; this test
 * pins the SQL itself so the two can't silently drift. We capture the Drizzle `.set()` payload
 * and render it with PgDialect — no Postgres required.
 */
function makeCapturingDb() {
  const captured: { set?: Record<string, unknown> } = {};
  const chain = {
    set(payload: Record<string, unknown>) {
      captured.set = payload;
      return { where: () => Promise.resolve(undefined) };
    },
  };
  const db = { update: vi.fn(() => chain) };
  return { db, captured };
}

describe("PinRepository.recordFailureEscalation — monotonic durable force-OTP mirror (F1)", () => {
  it("writes lockout_cycles + otp_cycle_count as GREATEST(column, value), not a blind number", async () => {
    const { db, captured } = makeCapturingDb();
    const repo = new PinRepository(db as never);

    // The lagging non-final write from the race: cycles=2, otp=0 — the values a blind write would
    // use to clobber a concurrently-latched (cycles=K, otp=1) row.
    await repo.recordFailureEscalation("worker-1", { lockoutCycles: 2, otpCycleCount: 0 });

    const set = captured.set;
    expect(set, "recordFailureEscalation must issue an update .set(...)").toBeDefined();

    // failed_attempts is a legitimate blind reset — a lockout STEP zeroes the transient counter.
    expect(set!.failedAttempts).toBe(0);

    // The two force-OTP latches must be SQL expressions, NOT raw numbers (a raw number is the
    // blind-overwrite regression that reopens F1).
    expect(is(set!.lockoutCycles, SQL), "lockout_cycles must be a SQL expression").toBe(true);
    expect(is(set!.otpCycleCount, SQL), "otp_cycle_count must be a SQL expression").toBe(true);

    const dialect = new PgDialect();
    const lc = dialect.sqlToQuery(set!.lockoutCycles as SQL);
    const oc = dialect.sqlToQuery(set!.otpCycleCount as SQL);

    // Monotonic: GREATEST(<column>, <boundParam>) — a lagging write can never LOWER the latch.
    expect(lc.sql.toLowerCase()).toContain("greatest");
    expect(lc.sql).toContain("lockout_cycles");
    expect(lc.params).toContain(2);

    expect(oc.sql.toLowerCase()).toContain("greatest");
    expect(oc.sql).toContain("otp_cycle_count");
    expect(oc.params).toContain(0);
  });
});
