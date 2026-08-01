import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  jobPostings,
  postingPlans,
  postingBoosts,
  payerCapacity,
  events,
  type Database,
} from "@badabhai/db";
import { PostingPlansRepository } from "./posting-plans.repository";

/**
 * STRUCTURAL tests for the ADR-0016/ADR-0013/ADR-0036 posting-plans repository (the
 * `reach.repository.test.ts` / `admin-actions.repository.test.ts` pattern): capture the
 * Drizzle fluent chain (or the raw `sql` template) and compile it with the real
 * `PgDialect`, asserting on the TEXT and the BOUND PARAMETERS — no live database.
 *
 * Scope (TD122): pure data-access coverage. The capacity chokepoint's atomicity (the
 * advisory lock + count-then-write under one tx) is proved by the SERVICE tests, which
 * mock this repository outright — what lives here is "does the SQL this repository
 * builds actually say what its comment claims": the active-vacancy predicate, the
 * GREATEST-never-lowers upsert, the boost-window EXTEND expression, the payer-scoped
 * quota top-up guard, the coupon-usage event-spine read.
 */

const dialect = new PgDialect();
const compile = (cond: unknown) => dialect.sqlToQuery(cond as SQL);
const text = (cond: unknown) => compile(cond).sql;
const params = (cond: unknown) => compile(cond).params;

const PAYER_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const POSTING_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const PLAN_ID = "cccccccc-0000-4000-8000-000000000003";

interface InsertCall {
  table: unknown;
  values: unknown;
  conflict?: unknown;
}

interface Captured {
  selection?: Record<string, unknown>;
  selectTable?: unknown;
  where?: unknown;
  orderBy?: unknown;
  limit?: number;
  updateTable?: unknown;
  updateSet?: Record<string, unknown>;
  inserts: InsertCall[];
  insertTable?: unknown;
  insertValues?: unknown;
  conflict?: unknown;
  executed: { sql: string; params: unknown[] }[];
}

/** Same capturing mock shape as unlocks.repository.test.ts, extended with `.for`-free chains
 * (this repository takes no row locks) and select-with-no-where support (`countActivePlansForPayer`
 * etc. still go through `.where`, but some counts have no `.orderBy`/`.limit`). */
function makeDb(opts: { rows?: unknown[]; sequence?: unknown[][] } = {}) {
  const captured: Captured = { inserts: [], executed: [] };
  const seq = opts.sequence ? [...opts.sequence] : undefined;
  const nextRows = () => (seq ? (seq.shift() ?? []) : (opts.rows ?? []));

  const selectChain = () => {
    const node: Record<string, unknown> = {
      from: (t: unknown) => {
        captured.selectTable = t;
        return node;
      },
      where: (c: unknown) => {
        captured.where = c;
        return node;
      },
      orderBy: (o: unknown) => {
        captured.orderBy = o;
        return node;
      },
      limit: (n: number) => {
        captured.limit = n;
        return node;
      },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(nextRows()).then(res, rej),
    };
    return node;
  };

  const insertChain = (table: unknown) => {
    const entry: InsertCall = { table, values: undefined };
    const build = () => ({
      returning: () => Promise.resolve(nextRows()),
      onConflictDoUpdate: (cfg: unknown) => {
        entry.conflict = cfg;
        captured.conflict = cfg;
        return build();
      },
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(undefined).then(res, rej),
    });
    return {
      values: (values: unknown) => {
        entry.values = values;
        captured.inserts.push(entry);
        captured.insertTable = table;
        captured.insertValues = values;
        return build();
      },
    };
  };

  const updateChain = (table: unknown) => ({
    set: (vals: Record<string, unknown>) => {
      captured.updateTable = table;
      captured.updateSet = vals;
      return {
        where: (c: unknown) => {
          captured.where = c;
          return {
            returning: () => Promise.resolve(nextRows()),
            then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
              Promise.resolve(undefined).then(res, rej),
          };
        },
      };
    },
  });

  const execute = (stmt: unknown) => {
    const q = compile(stmt);
    captured.executed.push({ sql: q.sql, params: q.params });
    return Promise.resolve(nextRows());
  };

  const handle = {
    select: (selection?: Record<string, unknown>) => {
      captured.selection = selection;
      return selectChain();
    },
    insert: insertChain,
    update: updateChain,
    execute,
  };

  const db = {
    ...handle,
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(handle),
  } as unknown as Database;

  return { db, tx: handle as unknown as Parameters<PostingPlansRepository["lockPayer"]>[0], captured };
}

describe("PostingPlansRepository.withTransaction", () => {
  it("delegates to db.transaction and returns the callback result", async () => {
    const { db } = makeDb();
    expect(await new PostingPlansRepository(db).withTransaction(async () => 7)).toBe(7);
  });
});

describe("PostingPlansRepository.lockPayer — per-payer advisory xact lock", () => {
  it("takes a transaction-scoped advisory lock keyed on the payer id", async () => {
    const { db, tx, captured } = makeDb();
    await new PostingPlansRepository(db).lockPayer(tx, PAYER_ID);
    expect(captured.executed).toHaveLength(1);
    const { sql, params: p } = captured.executed[0]!;
    expect(sql).toBe("select pg_advisory_xact_lock(hashtextextended($1, 0))");
    expect(p).toEqual([PAYER_ID]);
  });
});

describe("PostingPlansRepository.countActivePlansForPayer — DERIVED active-vacancy count", () => {
  it("counts rows for this payer, status=active, and (no expiry OR not-yet-expired)", async () => {
    const { db, tx, captured } = makeDb({ rows: [{ c: 3 }] });
    const now = new Date("2026-07-31T00:00:00.000Z");
    const out = await new PostingPlansRepository(db).countActivePlansForPayer(tx, PAYER_ID, now);
    expect(captured.selectTable).toBe(postingPlans);
    const { sql, params: p } = compile(captured.where);
    expect(sql).toBe(
      '("posting_plans"."payer_id" = $1 and "posting_plans"."status" = $2 and ("posting_plans"."expires_at" is null or "posting_plans"."expires_at" > $3))',
    );
    expect(p).toEqual([PAYER_ID, "active", now.toISOString()]);
    expect(out).toBe(3);
  });

  it("returns 0 when there is no row", async () => {
    const { db, tx } = makeDb({ rows: [] });
    expect(await new PostingPlansRepository(db).countActivePlansForPayer(tx, PAYER_ID, new Date())).toBe(0);
  });
});

describe("PostingPlansRepository.getCapacity — the allowance read, tx-optional", () => {
  it("uses `this.db` (the non-tx pool) when no tx is supplied", async () => {
    const { db, captured } = makeDb({ rows: [{ payerId: PAYER_ID, maxActiveVacancies: 5 }] });
    const out = await new PostingPlansRepository(db).getCapacity(PAYER_ID);
    expect(captured.selectTable).toBe(payerCapacity);
    expect(text(captured.where)).toBe('"payer_capacity"."payer_id" = $1');
    expect(params(captured.where)).toEqual([PAYER_ID]);
    expect(captured.limit).toBe(1);
    expect(out).toEqual({ payerId: PAYER_ID, maxActiveVacancies: 5 });
  });

  it("reads on the SAME connection as the passed tx (the deadlock-free discipline)", async () => {
    // The repository is built on a `db` that would error if `.select` were called on it —
    // proving `exec = tx ?? this.db` really took the tx branch, not silently `this.db`.
    const explodingDb = {
      select: () => {
        throw new Error("must not read on the pool when a tx is supplied");
      },
    } as unknown as Database;
    const { tx, captured: txCaptured } = makeDb({ rows: [{ payerId: PAYER_ID, maxActiveVacancies: 3 }] });
    const out = await new PostingPlansRepository(explodingDb).getCapacity(PAYER_ID, tx);
    expect(txCaptured.selectTable).toBe(payerCapacity);
    expect(out).toEqual({ payerId: PAYER_ID, maxActiveVacancies: 3 });
  });

  it("returns undefined when the payer has no capacity row", async () => {
    const { db } = makeDb({ rows: [] });
    expect(await new PostingPlansRepository(db).getCapacity(PAYER_ID)).toBeUndefined();
  });
});

describe("PostingPlansRepository.upsertCapacity — GREATEST-guarded allowance upsert", () => {
  const input = {
    payerId: PAYER_ID,
    maxActiveVacancies: 5,
    sourceTier: "tier_pro",
    expiresAt: new Date("2026-12-31T00:00:00.000Z"),
  };

  it("inserts the allowance row with the fields given", async () => {
    const { db, captured } = makeDb({ rows: [{ payerId: PAYER_ID, maxActiveVacancies: 5 }] });
    await new PostingPlansRepository(db).upsertCapacity(input);
    expect(captured.insertTable).toBe(payerCapacity);
    expect(captured.insertValues).toEqual({
      payerId: PAYER_ID,
      maxActiveVacancies: 5,
      sourceTier: "tier_pro",
      expiresAt: input.expiresAt,
    });
  });

  it("the ON CONFLICT target is payer_id, and the set uses GREATEST so a re-applied grant can never lower the allowance", async () => {
    const { db, captured } = makeDb({ rows: [{ payerId: PAYER_ID }] });
    await new PostingPlansRepository(db).upsertCapacity(input);
    const conflict = captured.conflict as { target: unknown; set: Record<string, unknown> };
    expect(conflict.target).toBe(payerCapacity.payerId);
    expect(text(conflict.set.maxActiveVacancies)).toBe(
      'greatest("payer_capacity"."max_active_vacancies", $1)',
    );
    expect(params(conflict.set.maxActiveVacancies)).toEqual([5]);
    expect(conflict.set.sourceTier).toBe("tier_pro");
    expect(conflict.set.expiresAt).toBe(input.expiresAt);
  });

  it("runs on a passed tx when supplied — the pool is never touched", async () => {
    const explodingDb = {
      insert: () => {
        throw new Error("must not write on the pool when a tx is supplied");
      },
    } as unknown as Database;
    const { tx, captured: txCaptured } = makeDb({ rows: [{ payerId: PAYER_ID }] });
    await new PostingPlansRepository(explodingDb).upsertCapacity(input, tx);
    expect(txCaptured.insertTable).toBe(payerCapacity);
  });

  it("throws when the upsert returns no row", async () => {
    const { db } = makeDb({ rows: [] });
    await expect(new PostingPlansRepository(db).upsertCapacity(input)).rejects.toThrow(
      "Failed to upsert payer capacity",
    );
  });
});

describe("PostingPlansRepository.listPausedPlansForPayer — deterministic auto-resume order", () => {
  it("scopes to payer + status=paused, oldest-paid first", async () => {
    const { db, tx, captured } = makeDb({ rows: [] });
    await new PostingPlansRepository(db).listPausedPlansForPayer(tx, PAYER_ID);
    expect(captured.selectTable).toBe(postingPlans);
    const { sql, params: p } = compile(captured.where);
    expect(sql).toBe('("posting_plans"."payer_id" = $1 and "posting_plans"."status" = $2)');
    expect(p).toEqual([PAYER_ID, "paused"]);
    expect(text(captured.orderBy)).toBe('"posting_plans"."paid_at" asc');
  });
});

describe("PostingPlansRepository.setPlanStatus — flip a plan's lifecycle status", () => {
  it("sets the given status (and updated_at), scoped by plan id", async () => {
    const { db, tx, captured } = makeDb();
    await new PostingPlansRepository(db).setPlanStatus(tx, PLAN_ID, "active");
    expect(captured.updateTable).toBe(postingPlans);
    expect(captured.updateSet!.status).toBe("active");
    expect(captured.updateSet!.updatedAt).toBeDefined();
    expect(text(captured.where)).toBe('"posting_plans"."id" = $1');
    expect(params(captured.where)).toEqual([PLAN_ID]);
  });
});

describe("PostingPlansRepository.postingExists — existence-only, no PII read", () => {
  it("projects ONLY id, scoped by id, limited to one", async () => {
    const { db, captured } = makeDb({ rows: [{ id: POSTING_ID }] });
    const out = await new PostingPlansRepository(db).postingExists(POSTING_ID);
    expect(captured.selectTable).toBe(jobPostings);
    expect(Object.keys(captured.selection!)).toEqual(["id"]);
    expect(text(captured.where)).toBe('"job_postings"."id" = $1');
    expect(params(captured.where)).toEqual([POSTING_ID]);
    expect(captured.limit).toBe(1);
    expect(out).toBe(true);
  });

  it("is false when no posting matches", async () => {
    const { db } = makeDb({ rows: [] });
    expect(await new PostingPlansRepository(db).postingExists(POSTING_ID)).toBe(false);
  });
});

describe("PostingPlansRepository.insertPlan — create a posting plan, tx-optional", () => {
  const input = {
    jobPostingId: POSTING_ID,
    payerId: PAYER_ID,
    tier: "standard" as const,
    applicantVisibilityQuota: 10,
    status: "active" as const,
  };

  it("inserts on `this.db` when no tx is given", async () => {
    const { db, captured } = makeDb({ rows: [{ id: PLAN_ID }] });
    const out = await new PostingPlansRepository(db).insertPlan(input);
    expect(captured.insertTable).toBe(postingPlans);
    expect(captured.insertValues).toBe(input);
    expect(out).toEqual({ id: PLAN_ID });
  });

  it("inserts on the passed tx when supplied — the pool is never touched", async () => {
    const explodingDb = {
      insert: () => {
        throw new Error("must not write on the pool when a tx is supplied");
      },
    } as unknown as Database;
    const { tx, captured: txCaptured } = makeDb({ rows: [{ id: PLAN_ID }] });
    await new PostingPlansRepository(explodingDb).insertPlan(input, tx);
    expect(txCaptured.insertTable).toBe(postingPlans);
  });

  it("throws when the insert returns no row", async () => {
    const { db } = makeDb({ rows: [] });
    await expect(new PostingPlansRepository(db).insertPlan(input)).rejects.toThrow(
      "Failed to create posting plan",
    );
  });
});

describe("PostingPlansRepository.insertBoost — create a booster receipt", () => {
  it("inserts the boost row and returns it", async () => {
    const input = {
      jobPostingId: POSTING_ID,
      payerId: PAYER_ID,
      tier: "boost_7" as const,
    };
    const { db, captured } = makeDb({ rows: [{ id: "boost-1" }] });
    const out = await new PostingPlansRepository(db).insertBoost(input);
    expect(captured.insertTable).toBe(postingBoosts);
    expect(captured.insertValues).toBe(input);
    expect(out).toEqual({ id: "boost-1" });
  });

  it("throws when the insert returns no row", async () => {
    const { db } = makeDb({ rows: [] });
    await expect(
      new PostingPlansRepository(db).insertBoost({
        jobPostingId: POSTING_ID,
        payerId: PAYER_ID,
        tier: "boost_7",
      }),
    ).rejects.toThrow("Failed to create posting boost");
  });
});

describe("PostingPlansRepository.extendPostingBoostWindow — ADR-0036 §7 EXTEND, never overwrite", () => {
  it("sets boosted_until to GREATEST(now(), COALESCE(boosted_until, now())) + N days, scoped by posting id", async () => {
    const { db, captured } = makeDb({ rows: [{ boostedUntil: new Date("2026-09-01T00:00:00.000Z") }] });
    const out = await new PostingPlansRepository(db).extendPostingBoostWindow(POSTING_ID, 7);
    expect(captured.updateTable).toBe(jobPostings);
    const boostedSql = text(captured.updateSet!.boostedUntil);
    expect(boostedSql).toContain("GREATEST(now(), COALESCE(");
    expect(boostedSql).toContain('"job_postings"."boosted_until"');
    expect(boostedSql).toContain("make_interval(days =>");
    expect(params(captured.updateSet!.boostedUntil)).toEqual([7]);
    expect(text(captured.where)).toBe('"job_postings"."id" = $1');
    expect(params(captured.where)).toEqual([POSTING_ID]);
    expect(out).toEqual(new Date("2026-09-01T00:00:00.000Z"));
  });

  it("returns null when no row matched (posting missing)", async () => {
    const { db } = makeDb({ rows: [] });
    expect(await new PostingPlansRepository(db).extendPostingBoostWindow(POSTING_ID, 7)).toBeNull();
  });
});

describe("PostingPlansRepository.findActiveBoost — B-R3 overlap guard", () => {
  it("scopes to posting + status=active + boost_ends_at > now", async () => {
    const { db, captured } = makeDb({ rows: [] });
    const now = new Date("2026-07-31T00:00:00.000Z");
    await new PostingPlansRepository(db).findActiveBoost(POSTING_ID, now);
    expect(captured.selectTable).toBe(postingBoosts);
    const { sql, params: p } = compile(captured.where);
    expect(sql).toBe(
      '("posting_boosts"."job_posting_id" = $1 and "posting_boosts"."status" = $2 and "posting_boosts"."boost_ends_at" > $3)',
    );
    expect(p).toEqual([POSTING_ID, "active", now.toISOString()]);
    expect(captured.limit).toBe(1);
  });
});

describe("PostingPlansRepository.findActivePlanForPostingAndPayer — the quota top-up target", () => {
  it("scopes to posting + payer + active + unexpired, latest-paid first", async () => {
    const { db, captured } = makeDb({ rows: [] });
    const now = new Date("2026-07-31T00:00:00.000Z");
    await new PostingPlansRepository(db).findActivePlanForPostingAndPayer(POSTING_ID, PAYER_ID, now);
    expect(captured.selectTable).toBe(postingPlans);
    const { sql, params: p } = compile(captured.where);
    expect(sql).toBe(
      '("posting_plans"."job_posting_id" = $1 and "posting_plans"."payer_id" = $2 and "posting_plans"."status" = $3 and ("posting_plans"."expires_at" is null or "posting_plans"."expires_at" > $4))',
    );
    expect(p).toEqual([POSTING_ID, PAYER_ID, "active", now.toISOString()]);
    expect(text(captured.orderBy)).toBe('"posting_plans"."paid_at" desc');
    expect(captured.limit).toBe(1);
  });
});

describe("PostingPlansRepository.addQuotaTopup — atomic composable top-up with a re-asserted guard", () => {
  it("adds delta to quota_topup_count via SQL, re-asserting plan/payer/active/unexpired", async () => {
    const { db, captured } = makeDb({ rows: [{ id: PLAN_ID, quotaTopupCount: 15 }] });
    const now = new Date("2026-07-31T00:00:00.000Z");
    const out = await new PostingPlansRepository(db).addQuotaTopup(PLAN_ID, PAYER_ID, 5, now);
    expect(captured.updateTable).toBe(postingPlans);
    expect(text(captured.updateSet!.quotaTopupCount)).toBe(
      '"posting_plans"."quota_topup_count" + $1',
    );
    expect(params(captured.updateSet!.quotaTopupCount)).toEqual([5]);
    const { sql, params: p } = compile(captured.where);
    expect(sql).toBe(
      '("posting_plans"."id" = $1 and "posting_plans"."payer_id" = $2 and "posting_plans"."status" = $3 and ("posting_plans"."expires_at" is null or "posting_plans"."expires_at" > $4))',
    );
    expect(p).toEqual([PLAN_ID, PAYER_ID, "active", now.toISOString()]);
    expect(out).toEqual({ id: PLAN_ID, quotaTopupCount: 15 });
  });

  it("returns undefined when the plan changed/expired between read and write (TOCTOU guard)", async () => {
    const { db } = makeDb({ rows: [] });
    expect(
      await new PostingPlansRepository(db).addQuotaTopup(PLAN_ID, PAYER_ID, 5, new Date()),
    ).toBeUndefined();
  });
});

describe("PostingPlansRepository.couponUsage — total + per-payer redemption counts from the event spine", () => {
  it("counts total redemptions for the coupon code, and this payer's redemptions, both scoped on the payload", async () => {
    const { db, captured } = makeDb({ sequence: [[{ c: 12 }], [{ c: 2 }]] });
    const out = await new PostingPlansRepository(db).couponUsage("SAVE10", PAYER_ID);
    expect(out).toEqual({ total: 12, perPayer: 2 });
    expect(captured.selectTable).toBe(events);
  });

  it("the total-count predicate scopes to eventName='coupon.redeemed' and payload->>coupon_code", async () => {
    const { db, captured } = makeDb({ sequence: [[{ c: 0 }], [{ c: 0 }]] });
    await new PostingPlansRepository(db).couponUsage("SAVE10", PAYER_ID);
    // Only the LAST where survives in `captured` (two selects run sequentially) — but both
    // predicates share the same `base` AND-clause, so the second (payer-scoped) one is a
    // superset we can inspect directly.
    const { sql, params: p } = compile(captured.where);
    expect(sql).toContain("\"events\".\"event_name\" = $1");
    expect(sql).toContain("'coupon_code'");
    expect(sql).toContain("\"events\".\"payload\" ->> 'coupon_code' = $2");
    expect(sql).toContain("'payer_id'");
    expect(sql).toContain("\"events\".\"payload\" ->> 'payer_id' = $3");
    expect(p).toEqual(["coupon.redeemed", "SAVE10", PAYER_ID]);
  });

  it("returns zeros when the event spine has no matching rows", async () => {
    const { db } = makeDb({ sequence: [[], []] });
    expect(await new PostingPlansRepository(db).couponUsage("NONE", PAYER_ID)).toEqual({
      total: 0,
      perPayer: 0,
    });
  });
});
