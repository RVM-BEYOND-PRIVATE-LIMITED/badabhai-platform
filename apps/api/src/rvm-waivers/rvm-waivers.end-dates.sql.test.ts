import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/pg-proxy";
import type { Database } from "@badabhai/db";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { RvmWaiversRepository } from "./rvm-waivers.repository";

/**
 * #2778 — the statements the waiver price reads send, as Drizzle builds them (a proxy driver
 * records each one; nothing connects to a database). What these pin:
 *
 *   - SWITCH OFF (or no config): no statement names `rvm_waiver_end_dates` and nothing asks
 *     whether it exists — every read is the one it was before #2778, so a deploy ahead of the
 *     migration changes nothing.
 *   - SWITCH ON, TABLE MISSING: only the `to_regclass` probe names it; the reads stay as before.
 *   - SWITCH ON, TABLE PRESENT: the quote's read (`waiversFor`, both joins), the open's re-read
 *     (`isActiveForShare`) and the in-force list all carry the SAME clause against the SAME clock
 *     (the database's `now()` in India time), so the quote and the open cannot disagree.
 */

const TENANT = "11111111-1111-4111-8111-111111111111" as TenantKey;
const WORKER = "22222222-2222-4222-8222-222222222222";
const WAIVER = "33333333-3333-4333-8333-333333333333";
const CLAUSE =
  'NOT EXISTS (SELECT 1 FROM "rvm_waiver_end_dates" WHERE "rvm_waiver_end_dates"."waiver_id" = "rvm_applicant_waivers"."id" AND "rvm_waiver_end_dates"."ends_on" < (now() AT TIME ZONE \'Asia/Kolkata\')::date)';

function recording(opts: { switchOn?: boolean; tablePresent?: boolean; noConfig?: boolean } = {}) {
  const executed: string[] = [];
  const db = drizzle(async (sql) => {
    executed.push(sql);
    // `execute` hands the driver's rows back as they are: objects, as postgres-js answers them.
    if (sql.includes("to_regclass")) return { rows: [{ present: opts.tablePresent ?? true }] };
    return { rows: [] };
  }) as unknown as Database;
  const repo = opts.noConfig
    ? new RvmWaiversRepository(db)
    : new RvmWaiversRepository(db, { RVM_WAIVER_END_DATES_ENABLED: opts.switchOn ?? false });
  return { repo, db, executed };
}

async function everyRead(repo: RvmWaiversRepository, db: Database): Promise<void> {
  await repo.waiversFor(TENANT, [WORKER]);
  await repo.isActiveForShare(db, WAIVER);
  await repo.list({ tenant: TENANT, includeCleared: false, after: null, limit: 10 });
  await repo.list({ tenant: TENANT, includeCleared: true, after: null, limit: 10 });
}

const naming = (executed: string[]) => executed.filter((s) => s.includes("rvm_waiver_end_dates"));

describe("rvm waiver price reads — end dates (#2778)", () => {
  it.each([
    ["switch off", { switchOn: false }],
    ["no config at all", { noConfig: true }],
  ])("%s: nothing names rvm_waiver_end_dates, nothing probes for it", async (_n, opts) => {
    const { repo, db, executed } = recording(opts);
    await everyRead(repo, db);
    expect(executed.length).toBeGreaterThan(0);
    expect(naming(executed)).toEqual([]);
    expect(executed.filter((s) => s.includes("to_regclass"))).toEqual([]);
    expect(repo.endDatesEnabled).toBe(false);
    expect(await repo.endsOf([WAIVER])).toEqual(new Map());
  });

  it("switch on, table missing: only the probe names it, and the reads are today's", async () => {
    const off = recording({ switchOn: false });
    await everyRead(off.repo, off.db);
    const { repo, db, executed } = recording({ switchOn: true, tablePresent: false });
    await everyRead(repo, db);
    const reads = executed.filter((s) => !s.includes("to_regclass"));
    expect(naming(reads)).toEqual([]);
    expect(reads).toEqual(off.executed);
  });

  it("switch on, table present: the quote's two joins, the open's re-read and the in-force list carry one clause", async () => {
    const { repo, db, executed } = recording({ switchOn: true, tablePresent: true });
    await repo.waiversFor(TENANT, [WORKER]);
    const quote = executed.filter((s) => s.includes('from "applications"'));
    expect(quote).toHaveLength(2);
    for (const s of quote) expect(s).toContain(CLAUSE);

    executed.length = 0;
    await repo.isActiveForShare(db, WAIVER);
    const open = executed.find((s) => s.includes("for share"))!;
    expect(open).toContain(CLAUSE);

    executed.length = 0;
    await repo.list({ tenant: TENANT, includeCleared: false, after: null, limit: 10 });
    expect(executed.find((s) => s.includes('from "rvm_applicant_waivers"'))).toContain(CLAUSE);

    // The full history (cleared included) shows ended waivers too.
    executed.length = 0;
    await repo.list({ tenant: TENANT, includeCleared: true, after: null, limit: 10 });
    expect(executed.find((s) => s.includes('from "rvm_applicant_waivers"'))).not.toContain(CLAUSE);
  });

  it("the table is probed once and then trusted", async () => {
    const { repo, db, executed } = recording({ switchOn: true, tablePresent: true });
    expect(await repo.endDatesReadable()).toBe(true);
    await everyRead(repo, db);
    await everyRead(repo, db);
    expect(executed.filter((s) => s.includes("to_regclass"))).toHaveLength(1);
  });

  it("a missing table is asked about again only after a pause, not on every read", async () => {
    const { repo, db, executed } = recording({ switchOn: true, tablePresent: false });
    await everyRead(repo, db);
    await everyRead(repo, db);
    expect(executed.filter((s) => s.includes("to_regclass"))).toHaveLength(1);
    expect(await repo.endDatesReadable()).toBe(false);
  });
});
