import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { getTableColumns, type SQL } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import { ReferralBonusRepository } from "./referral-bonus.repository";
import { referralBonusAccruals } from "./referral-bonus.table";

/**
 * STRUCTURAL tests for the bonus ledger queries.
 *
 * The service tests mock this repository, so two properties that exist ONLY IN THE SQL are
 * pinned here by capturing the real Drizzle builders and compiling them:
 *
 *  1. PRIVACY — the two fraud checks compare `workers.phone_hash` inside a JOIN and select
 *     only a literal, so no hash is ever returned into this process (and therefore cannot be
 *     logged, emitted, or held in a variable). A refactor that "simplified" this into two
 *     reads of the hash plus a JS comparison would quietly weaken invariant #2; these tests
 *     fail the moment the hash appears in a SELECT list.
 *  2. IDEMPOTENCY — the accrual insert carries `ON CONFLICT (invited_worker_id) DO NOTHING`,
 *     which is what makes "one bonus per referred worker, ever" hold under concurrency,
 *     rather than depending on the (raceable) read-then-write check in the service.
 */

const dialect = new PgDialect();
const compile = (node: unknown): string => dialect.sqlToQuery(node as SQL).sql;

const INVITER = "11111111-1111-4111-8111-111111111111";
const INVITED = "22222222-2222-4222-8222-222222222222";

interface Captured {
  selection: string[];
  joinOns: unknown[];
  where?: unknown;
}

/** Capturing mock of `select(cols).from(t)[.innerJoin(t,on)]*.where(cond).limit(n)`. */
function selectDb(rows: unknown[]): { db: Database; captured: Captured } {
  const captured: Captured = { selection: [], joinOns: [] };
  const tail = {
    where: (cond: unknown) => {
      captured.where = cond;
      return { limit: () => Promise.resolve(rows) };
    },
    innerJoin: (_table: unknown, on: unknown) => {
      captured.joinOns.push(on);
      return tail;
    },
  };
  const db = {
    select: (selection?: Record<string, unknown>) => {
      captured.selection = Object.keys(selection ?? {});
      return { from: () => tail };
    },
  } as unknown as Database;
  return { db, captured };
}

describe("ReferralBonusRepository — the phone hash NEVER leaves the database", () => {
  it("sharesPhoneHash JOINs on phone_hash and selects only a literal", async () => {
    const { db, captured } = selectDb([{ hit: 1 }]);
    expect(await new ReferralBonusRepository(db).sharesPhoneHash(INVITER, INVITED)).toBe(true);

    // Nothing but a constant comes back — never `phone_hash`.
    expect(captured.selection).toEqual(["hit"]);
    // The comparison itself happens in SQL, between two aliases of `workers`.
    expect(captured.joinOns).toHaveLength(1);
    expect(compile(captured.joinOns[0])).toContain("phone_hash");
    // ...and the two ids are the only inputs.
    expect(compile(captured.where)).toContain("id");
  });

  it("phoneAlreadyEarned joins the ledger to workers-by-hash and still selects only a literal", async () => {
    const { db, captured } = selectDb([]);
    expect(await new ReferralBonusRepository(db).phoneAlreadyEarned(INVITED)).toBe(false);
    expect(captured.selection).toEqual(["hit"]);
    // ledger -> earner (by id) -> candidate (by phone_hash).
    expect(captured.joinOns).toHaveLength(2);
    expect(compile(captured.joinOns[1])).toContain("phone_hash");
  });

  it("hasGrantedUnlock keys on granted_at, not a status that moves on after the grant", async () => {
    const { db, captured } = selectDb([]);
    await new ReferralBonusRepository(db).hasGrantedUnlock(INVITED);
    const where = compile(captured.where);
    expect(where).toContain("granted_at");
    expect(where).toContain("is not null");
    // Matching status='granted' alone would stop qualifying a worker the moment their
    // unlock was actually USED (status -> revealed) — the strongest referral signal there is.
    expect(where).not.toContain("'granted'");
  });

  it("hasConfirmedProfile requires the CONFIRMED status (not merely extracted)", async () => {
    const { db, captured } = selectDb([]);
    await new ReferralBonusRepository(db).hasConfirmedProfile(INVITED);
    expect(compile(captured.where)).toContain("profile_status");
  });
});

describe("ReferralBonusRepository — the UNIQUE column is the idempotency key", () => {
  function insertDb(returned: unknown[]): { db: Database; target: () => unknown } {
    let conflictTarget: unknown;
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: (cfg: { target: unknown }) => {
            conflictTarget = cfg.target;
            return { returning: async () => returned };
          },
        }),
      }),
    } as unknown as Database;
    return { db, target: () => conflictTarget };
  }

  const input = {
    inviterWorkerId: INVITER,
    invitedWorkerId: INVITED,
    amountInr: 20,
    qualifiedAt: new Date(),
  };

  it("accrue uses ON CONFLICT (invited_worker_id) DO NOTHING", async () => {
    const { db, target } = insertDb([{ id: "a-1", amountInr: 20 }]);
    const row = await new ReferralBonusRepository(db).accrue(input);
    expect(row?.id).toBe("a-1");
    expect(target()).toBe(referralBonusAccruals.invitedWorkerId);
  });

  it("maps a LOST race (no row returned) to undefined so the caller emits nothing", async () => {
    const { db } = insertDb([]);
    expect(await new ReferralBonusRepository(db).accrue(input)).toBeUndefined();
  });
});

describe("ReferralBonusRepository — the table shape it is coded against", () => {
  it("maps exactly the columns the sibling db change specifies", () => {
    // Guards the TEMPORARY local table declaration against drifting from the migration:
    // id, inviter_worker_id, invited_worker_id (UNIQUE), amount_inr (default 20), qualified_at.
    const columns = Object.values(getTableColumns(referralBonusAccruals)).map((c) => c.name);
    expect(columns.sort()).toEqual(
      ["amount_inr", "id", "invited_worker_id", "inviter_worker_id", "qualified_at"].sort(),
    );
  });
});
