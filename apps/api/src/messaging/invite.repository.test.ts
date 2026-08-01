import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { type Database } from "@badabhai/db";
import { InviteRepository } from "./invite.repository";

/**
 * STRUCTURAL test for the TD115 single-attribution guard.
 *
 * WHY THIS FILE EXISTS. `invite.service.test.ts` has a test named "rejects a RACE where the
 * read check passes but the write guard wins (TOCTOU safety)" — but it STUBS
 * `repo.markAccepted` to return `false` and asserts the service handles that. It tests the
 * service's reaction to a lost race; it cannot test whether the race is ever actually lost,
 * because the repository is mocked away.
 *
 * Measured 2026-08-01: deleting `isNull(invites.invitedWorkerId)` from `markAccepted` leaves
 * ALL 10 tests in `invite.service.test.ts` green. The guard that TD115 was raised about, and
 * that the register recorded as "Paid", was pinned by nothing. That is the whole TOCTOU:
 * without the predicate, two different workers racing on one code both UPDATE, last write
 * wins on `invited_worker_id`, and the `invite.accepted:${id}` idempotency key dedupes the
 * event — so the row and the event disagree about who was attributed.
 *
 * Asserted on the COMPILED SQL (the house `reach.repository.test.ts` /
 * `match-config.repository.test.ts` pattern) because the predicate is the entire fix: it is
 * what makes the UPDATE affect 0 rows for the loser, which is what `markAccepted` returns
 * `false` for, which is what the service test stubs.
 */

const dialect = new PgDialect();
const compile = (cond: unknown) => dialect.sqlToQuery(cond as SQL);

const INVITE = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";

type Captured = { set?: Record<string, unknown>; where?: unknown };

/** Capturing mock of the update().set().where().returning() chain. */
function makeDb(returnRows: Array<{ id: string }>) {
  const captured: Captured = {};
  const db = {
    update: () => ({
      set: (v: Record<string, unknown>) => {
        captured.set = v;
        return {
          where: (cond: unknown) => {
            captured.where = cond;
            return { returning: async () => returnRows };
          },
        };
      },
    }),
  } as unknown as Database;
  return { db, captured };
}

describe("InviteRepository.markAccepted — the TD115 single-attribution guard", () => {
  it("guards the UPDATE on invited_worker_id IS NULL, not on id alone", async () => {
    const { db, captured } = makeDb([{ id: INVITE }]);
    await new InviteRepository(db).markAccepted(INVITE, WORKER);

    const q = compile(captured.where);
    // The `is null` half is the fix. Without it the UPDATE matches an already-attributed
    // row and silently re-points `invited_worker_id` at the loser of the race.
    expect(q.sql).toContain('"invited_worker_id" is null');
    // ...and the id half must survive too — a guard that dropped it would attribute EVERY
    // unattributed invite in the table to this worker.
    expect(q.sql).toContain('"id" = $1');
    expect(q.params).toEqual([INVITE]);
  });

  it("returns TRUE when the UPDATE claimed the row (this worker won the race)", async () => {
    const { db } = makeDb([{ id: INVITE }]);
    expect(await new InviteRepository(db).markAccepted(INVITE, WORKER)).toBe(true);
  });

  it("returns FALSE when the UPDATE matched nothing (someone else already claimed it)", async () => {
    // 0 rows is what the `is null` predicate produces for the loser. This is the value the
    // service test stubs — here it is derived from the row count instead of asserted about.
    const { db } = makeDb([]);
    expect(await new InviteRepository(db).markAccepted(INVITE, WORKER)).toBe(false);
  });

  it("writes the attribution and the accepted status in the same UPDATE", async () => {
    const { db, captured } = makeDb([{ id: INVITE }]);
    await new InviteRepository(db).markAccepted(INVITE, WORKER);

    // Status and attribution must move together: a row reading `accepted` with a null
    // `invited_worker_id` (or the reverse) is the inconsistency the guard exists to prevent.
    expect(captured.set?.status).toBe("accepted");
    expect(captured.set?.invitedWorkerId).toBe(WORKER);
    expect(captured.set?.updatedAt).toBeInstanceOf(Date);
  });

  it("carries NO PII into the write — worker ids and status only", () => {
    const { db, captured } = makeDb([{ id: INVITE }]);
    return new InviteRepository(db).markAccepted(INVITE, WORKER).then(() => {
      // §2 invariant #2: `invites` is a PII-free seam (opaque code + worker ids).
      const keys = Object.keys(captured.set ?? {}).sort();
      expect(keys).toEqual(["invitedWorkerId", "status", "updatedAt"]);
    });
  });
});
