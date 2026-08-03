import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { type Database, type ReferralLinkMedium } from "@badabhai/db";
import { ReferralLinkRepository } from "./referral-link.repository";

/**
 * STRUCTURAL test for the B4 first-touch claim — the three concurrency protections in
 * {@link ReferralLinkRepository.claimFirstTouch}, asserted on the COMPILED SQL.
 *
 * WHY THIS FILE EXISTS, and it is not a hypothetical. `referral-link.service.test.ts` has
 * tests named "RACE: a concurrent duplicate post claims exactly ONCE" and "the loser hitting
 * the UNIQUE index is neutralised" — but both STUB `repo.claimFirstTouch` with a JS closure.
 * They test the SERVICE's reaction to winning or losing a race; they cannot test whether the
 * race is ever actually lost, because the repository is mocked away.
 *
 * That is exactly the shape TD115 already got wrong once in this codebase: its "TOCTOU
 * safety" test stubbed `repo.markAccepted` to return false, the register recorded the guard
 * as Paid, and deleting the actual `isNull(...)` predicate left all 10 of those tests GREEN.
 * The guard was pinned by nothing for weeks. This file is the same remedy applied to the
 * newer, larger guard, using the same PgDialect-compile technique
 * (`invite.repository.test.ts`, `reach.repository.test.ts`, `match-config.repository.test.ts`).
 *
 * WHAT THIS DOES AND DOES NOT PROVE. It proves the emitted SQL CONTAINS each protection:
 * the advisory lock, `FOR UPDATE`, the medium-dependent window predicate, first-touch
 * ordering, and the single-winner UPDATE guard — and that deleting any of them turns this
 * file red. It does NOT prove Postgres then behaves correctly under real concurrency; that
 * still wants a live-database e2e under RUN_DB_TESTS. But a missing predicate is the failure
 * mode that actually ships, and it is now caught without needing a database.
 */

const dialect = new PgDialect();
const compile = (cond: unknown) => dialect.sqlToQuery(cond as SQL);

const CODE = "abcdef012345";
const WORKER = "22222222-2222-4222-8222-222222222222";
const CLICK = "33333333-3333-4333-8333-333333333333";
const LINK = "44444444-4444-4444-8444-444444444444";

/** Fixed clock so the two window cutoffs are exact, comparable values. */
const NOW = new Date("2026-08-01T12:00:00.000Z");
const WINDOWS: Record<ReferralLinkMedium, number> = { organic: 168, paid: 24 };

const HOUR = 60 * 60 * 1000;
const ORGANIC_CUTOFF = new Date(NOW.getTime() - WINDOWS.organic * HOUR);
const PAID_CUTOFF = new Date(NOW.getTime() - WINDOWS.paid * HOUR);

const candidateRow = {
  id: CLICK,
  referralLinkId: LINK,
  medium: "organic" as const,
  clickedAt: new Date(NOW.getTime() - 2 * HOUR),
};

interface Captured {
  /** Ordered log of the operations issued inside the transaction. */
  order: string[];
  lockSql?: string;
  lockParams?: unknown[];
  existingWhere?: unknown;
  candidateWhere?: unknown;
  candidateOrderBy?: unknown;
  forMode?: string;
  updateSet?: Record<string, unknown>;
  updateWhere?: unknown;
}

/**
 * Capturing mock of the tx chain claimFirstTouch drives:
 *   execute(sql)                                        → the advisory lock
 *   select().from().where().limit()                     → the existing-claim probe
 *   select().from().where().orderBy().limit().for()     → the candidate
 *   update().set().where().returning()                  → the single-winner write
 * Drizzle's builders are thenable, so the mock's terminal links are too.
 */
function makeDb(opts: {
  existing?: unknown[];
  candidate?: unknown[];
  updated?: Array<{ id: string }>;
}) {
  const c: Captured = { order: [] };
  let selectCall = 0;

  const thenable = (rows: unknown[]) => ({
    then: (resolve: (v: unknown) => void) => resolve(rows),
  });

  const tx = {
    execute: async (q: unknown) => {
      const { sql, params } = compile(q);
      c.order.push("lock");
      c.lockSql = sql;
      c.lockParams = params;
    },
    select: () => {
      const call = ++selectCall;
      return {
        from: () => ({
          where: (cond: unknown) => {
            if (call === 1) {
              c.order.push("select:existing");
              c.existingWhere = cond;
            } else {
              c.order.push("select:candidate");
              c.candidateWhere = cond;
            }
            const rows = call === 1 ? (opts.existing ?? []) : (opts.candidate ?? []);
            const terminal = {
              ...thenable(rows),
              for: (mode: string) => {
                c.forMode = mode;
                return thenable(rows);
              },
            };
            return {
              limit: () => terminal,
              orderBy: (o: unknown) => {
                c.candidateOrderBy = o;
                return { limit: () => terminal };
              },
            };
          },
        }),
      };
    },
    update: () => ({
      set: (v: Record<string, unknown>) => {
        c.order.push("update");
        c.updateSet = v;
        return {
          where: (cond: unknown) => {
            c.updateWhere = cond;
            return { returning: async () => opts.updated ?? [] };
          },
        };
      },
    }),
  };

  const db = {
    transaction: async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
  } as unknown as Database;

  return { db, c };
}

const claim = (db: Database) =>
  new ReferralLinkRepository(db).claimFirstTouch({
    code: CODE,
    workerId: WORKER,
    windowHoursByMedium: WINDOWS,
    now: NOW,
  });

describe("claimFirstTouch — protection 1: the per-worker advisory lock", () => {
  it("takes pg_advisory_xact_lock keyed on the WORKER id, inside the transaction", async () => {
    const { db, c } = makeDb({ candidate: [candidateRow], updated: [{ id: CLICK }] });
    await claim(db);

    // This is the protection that actually handles the real race: two concurrent posts
    // carrying DIFFERENT codes pick DIFFERENT candidate rows, so `FOR UPDATE` on those two
    // rows blocks neither. Serializing per worker is what makes the second attempt observe
    // the first one's committed claim.
    expect(c.lockSql).toContain("pg_advisory_xact_lock");
    expect(c.lockSql).toContain("hashtextextended");
    expect(c.lockParams).toEqual([WORKER]);
  });

  it("takes the lock BEFORE reading any candidate — a lock after the read protects nothing", async () => {
    const { db, c } = makeDb({ candidate: [candidateRow], updated: [{ id: CLICK }] });
    await claim(db);

    expect(c.order[0]).toBe("lock");
    expect(c.order.indexOf("lock")).toBeLessThan(c.order.indexOf("select:candidate"));
  });
});

describe("claimFirstTouch — protection 2: FOR UPDATE on the winning candidate", () => {
  it("selects the candidate row FOR UPDATE", async () => {
    const { db, c } = makeDb({ candidate: [candidateRow], updated: [{ id: CLICK }] });
    await claim(db);
    expect(c.forMode).toBe("update");
  });
});

describe("claimFirstTouch — protection 3: the single-winner UPDATE guard", () => {
  it("guards the UPDATE on claimed_by_worker_id IS NULL, not on the row id alone", async () => {
    const { db, c } = makeDb({ candidate: [candidateRow], updated: [{ id: CLICK }] });
    await claim(db);

    const q = compile(c.updateWhere);
    // Without this the UPDATE would re-point an ALREADY-claimed click at a second worker,
    // which is the same defect class TD115 fixed on the invites seam.
    expect(q.sql).toContain('"claimed_by_worker_id" is null');
    expect(q.sql).toContain('"id" = $1');
    expect(q.params).toEqual([CLICK]);
  });

  it("stamps the worker AND the claim timestamp together (the claim_pair CHECK)", async () => {
    const { db, c } = makeDb({ candidate: [candidateRow], updated: [{ id: CLICK }] });
    await claim(db);

    // referral_clicks_claim_pair_chk requires both set or neither; writing one without the
    // other is a constraint violation at runtime, so they must move in one statement.
    expect(c.updateSet?.claimedByWorkerId).toBe(WORKER);
    expect(c.updateSet?.claimedAt).toBeInstanceOf(Date);
    expect(Object.keys(c.updateSet ?? {}).sort()).toEqual(["claimedAt", "claimedByWorkerId"]);
  });

  it("returns null when the UPDATE matched nothing (this worker lost the race)", async () => {
    const { db } = makeDb({ candidate: [candidateRow], updated: [] });
    expect(await claim(db)).toBeNull();
  });
});

describe("claimFirstTouch — the MATCH WINDOW predicate", () => {
  it("filters unclaimed clicks for THIS code, per-medium, inside the window", async () => {
    const { db, c } = makeDb({ candidate: [candidateRow], updated: [{ id: CLICK }] });
    await claim(db);

    const q = compile(c.candidateWhere);
    expect(q.sql).toContain('"code" = $1');
    expect(q.sql).toContain('"claimed_by_worker_id" is null');
    // The window is chosen PER CLICK from that click's own snapshotted medium, so an
    // organic and a paid click competing for one install are each judged under their rule.
    expect(q.sql.toLowerCase()).toContain("case");
    expect(q.sql).toContain("'paid'");
    expect(q.sql).toContain('"clicked_at" >=');
  });

  it("passes BOTH cutoffs, derived from the CONFIGURED hours — never a hardcoded window", async () => {
    const { db, c } = makeDb({ candidate: [candidateRow], updated: [{ id: CLICK }] });
    await claim(db);

    const q = compile(c.candidateWhere);
    const dates = q.params.filter((p): p is Date => p instanceof Date).map((d) => d.getTime());
    // 24h and 168h produce two DISTINCT cutoffs; a single cutoff would mean one window is
    // silently being applied to both media.
    expect(dates).toContain(PAID_CUTOFF.getTime());
    expect(dates).toContain(ORGANIC_CUTOFF.getTime());
    expect(new Set(dates).size).toBeGreaterThan(1);
  });

  it("re-tuning the config moves the cutoffs — the window is not baked into the SQL", async () => {
    const { db, c } = makeDb({ candidate: [candidateRow], updated: [{ id: CLICK }] });
    await new ReferralLinkRepository(db).claimFirstTouch({
      code: CODE,
      workerId: WORKER,
      windowHoursByMedium: { organic: 72, paid: 6 },
      now: NOW,
    });

    const dates = compile(c.candidateWhere)
      .params.filter((p): p is Date => p instanceof Date)
      .map((d) => d.getTime());
    expect(dates).toContain(new Date(NOW.getTime() - 72 * HOUR).getTime());
    expect(dates).toContain(new Date(NOW.getTime() - 6 * HOUR).getTime());
  });

  it("orders by clicked_at ASC — FIRST touch wins, not last", async () => {
    const { db, c } = makeDb({ candidate: [candidateRow], updated: [{ id: CLICK }] });
    await claim(db);

    // Descending here would silently invert the attribution rule: the most recent click
    // would take credit for an install the earliest share actually produced.
    expect(compile(c.candidateOrderBy).sql.toLowerCase()).toContain("asc");
    expect(compile(c.candidateOrderBy).sql).toContain('"clicked_at"');
  });
});

describe("claimFirstTouch — idempotency for a worker who already claimed", () => {
  it("probes for an existing claim scoped to THIS worker", async () => {
    const { db, c } = makeDb({ existing: [{ id: CLICK }] });
    await claim(db);

    const q = compile(c.existingWhere);
    expect(q.sql).toContain('"claimed_by_worker_id" = $1');
    expect(q.params).toEqual([WORKER]);
  });

  it("short-circuits BEFORE the candidate read and the UPDATE when one exists", async () => {
    const { db, c } = makeDb({ existing: [{ id: CLICK }] });
    expect(await claim(db)).toBeNull();

    // Re-claiming would violate referral_clicks_claimed_worker_uq; not attempting the write
    // is what keeps a duplicate post an idempotent no-op rather than a caught exception.
    expect(c.order).not.toContain("update");
    expect(c.order).not.toContain("select:candidate");
  });

  it("returns null when nothing is in the window (no candidate, no write attempted)", async () => {
    const { db, c } = makeDb({ candidate: [] });
    expect(await claim(db)).toBeNull();
    expect(c.order).not.toContain("update");
  });
});

describe("claimFirstTouch — PII boundary (invariant #2)", () => {
  it("the whole statement carries only opaque ids, an opaque code and timestamps", async () => {
    const { db, c } = makeDb({ candidate: [candidateRow], updated: [{ id: CLICK }] });
    await claim(db);

    const params = [
      ...(c.lockParams ?? []),
      ...compile(c.candidateWhere).params,
      ...compile(c.updateWhere).params,
    ];
    for (const p of params) {
      const ok = p instanceof Date || p === WORKER || p === CODE || p === CLICK;
      expect(ok, `unexpected param in claim SQL: ${String(p)}`).toBe(true);
    }
  });
});
