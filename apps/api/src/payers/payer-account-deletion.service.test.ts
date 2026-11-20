import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ConflictException } from "@nestjs/common";
import { displayPrefs, payerOrgs, payers } from "@badabhai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { PayerAccountDeletionService } from "./payer-account-deletion.service";

const CTX = { requestId: "req-1", correlationId: "corr-1" } as const;
const PAYER = "11111111-1111-4111-8111-111111111111";
const ORG = "33333333-3333-4333-8333-333333333333";

/** Chainable drizzle-select stub branching on the FROM table. */
function mockDb(
  orgRows: Array<{ id: string }>,
  memberRows: Array<unknown>,
  order: string[],
  payerDeleteFails = false,
) {
  const deletedTables: unknown[] = [];
  /** The WHERE of every delete, in order (compiled by the tests that read it). */
  const deleteWheres: unknown[] = [];
  /** The executor the row delete ran on: the db itself, or the transaction's handle. */
  const executors: unknown[] = [];
  const TX = { name: "tx" };
  /** The executor every org read ran on (#2811: the transaction's, never the pool's). */
  const selectExecutors: unknown[] = [];
  const selectOn = (executor: unknown) =>
    vi.fn(() => {
      selectExecutors.push(executor);
      return {
        from: vi.fn((table: unknown) => ({
          where: vi.fn(async () => (table === payerOrgs ? orgRows : memberRows)),
        })),
      };
    });
  const db = {
    select: selectOn("db"),
    delete: vi.fn((table: unknown) => deleteOn(db, table)),
    // #2811 — the WHOLE delete is one transaction: the solo org, the row (and its cascades and
    // erasures), the theme row and the drive-contact erasure.
    transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      order.push("tx:begin");
      try {
        const out = await work(TX);
        order.push("tx:commit");
        return out;
      } catch (err) {
        order.push("tx:rollback");
        throw err;
      }
    }),
  };
  Object.assign(TX, {
    select: selectOn(TX),
    delete: vi.fn((table: unknown) => deleteOn(TX, table)),
  });
  function deleteOn(executor: unknown, table: unknown) {
    deletedTables.push(table);
    executors.push(executor);
    order.push(
      table === payers
        ? "delete:payers"
        : table === displayPrefs
          ? "delete:display_prefs"
          : "delete:other",
    );
    return {
      where: vi.fn(async (where: unknown) => {
        deleteWheres.push(where);
        if (table === payers && payerDeleteFails) {
          // What a foreign key still holding the row (employer_profiles) raises.
          throw Object.assign(new Error("violates foreign key constraint"), { code: "23503" });
        }
        return undefined;
      }),
    };
  }
  return { deletedTables, deleteWheres, executors, selectExecutors, db, TX };
}

function makeService(opts: {
  rowFound: boolean;
  orgRows?: Array<{ id: string }>;
  memberRows?: Array<unknown>;
  sessionsRevoked?: number;
  revokeThrows?: boolean;
  payerDeleteFails?: boolean;
}) {
  const order: string[] = [];
  const { deletedTables, deleteWheres, db, executors, selectExecutors, TX } = mockDb(
    opts.orgRows ?? [],
    opts.memberRows ?? [],
    order,
    opts.payerDeleteFails,
  );
  const payersRepo = {
    findById: vi.fn(async () => (opts.rowFound ? ({ id: PAYER } as never) : undefined)),
  };
  const sessions = {
    revokeAllForPayer: opts.revokeThrows
      ? vi.fn(async () => {
          throw new Error("redis down");
        })
      : vi.fn(async () => opts.sessionsRevoked ?? 0),
  };
  const events = { emit: vi.fn(async () => undefined) };
  // #2746 PR 6 — the campus-drive contacts the login entered.
  const driveContacts = {
    eraseEnteredBy: vi.fn(async (_payerId: string, _executor?: unknown) => {
      order.push("erase:drive_contacts");
      return 1;
    }),
  };
  const svc = new PayerAccountDeletionService(
    db as never,
    payersRepo as never,
    sessions as never,
    events as never,
    driveContacts as never,
  );
  return {
    svc,
    payersRepo,
    sessions,
    events,
    deletedTables,
    deleteWheres,
    db,
    driveContacts,
    order,
    executors,
    selectExecutors,
    TX,
  };
}

describe("PayerAccountDeletionService.execute (QA immediate seam)", () => {
  it("is a no-op on an already-gone payer (idempotent re-run)", async () => {
    const { svc, sessions, events, db } = makeService({ rowFound: false });
    const out = await svc.execute(PAYER, { ...CTX });
    expect(out).toEqual({ deleted: false, sessionsRevoked: 0, soloOrgDeleted: false });
    expect(sessions.revokeAllForPayer).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("revokes sessions first, removes the solo org, deletes the row, emits the PII-free event", async () => {
    const { svc, sessions, events, deletedTables } = makeService({
      rowFound: true,
      orgRows: [{ id: ORG }],
      memberRows: [{ memberPayerId: PAYER, status: "active" }],
      sessionsRevoked: 2,
    });
    const out = await svc.execute(PAYER, { ...CTX });
    expect(out).toEqual({ deleted: true, sessionsRevoked: 2, soloOrgDeleted: true });
    expect(sessions.revokeAllForPayer).toHaveBeenCalledWith(PAYER);
    // members + org + payer row + the login's theme row (#2837) removed (4 deletes).
    expect(deletedTables).toHaveLength(4);
    expect(events.emit).toHaveBeenCalledOnce();
    const emitMock = events.emit as unknown as { mock: { calls: Array<[Record<string, unknown>]> } };
    const emitCall = emitMock.mock.calls[0]![0];
    expect(emitCall["event_name"]).toBe("payer.account_deleted");
    expect(emitCall["payload"]).toEqual({
      payer_id: PAYER,
      sessions_revoked: 2,
      solo_org_deleted: true,
    });
    expect(JSON.stringify(emitCall)).not.toContain("@");
  });

  it("deletes a payer with no org (no solo org to remove)", async () => {
    const { svc, events } = makeService({ rowFound: true, orgRows: [] });
    const out = await svc.execute(PAYER, { ...CTX });
    expect(out.deleted).toBe(true);
    expect(out.soloOrgDeleted).toBe(false);
    expect(events.emit).toHaveBeenCalledOnce();
  });

  it("409s when the payer owns a SHARED org — never destroys a team", async () => {
    const OTHER = "22222222-2222-4222-8222-222222222222";
    const { svc, events, db, deletedTables } = makeService({
      rowFound: true,
      orgRows: [{ id: ORG }],
      memberRows: [
        { memberPayerId: PAYER, status: "active" },
        { memberPayerId: OTHER, status: "active" },
      ],
    });
    await expect(svc.execute(PAYER, { ...CTX })).rejects.toBeInstanceOf(ConflictException);
    // The payer row is NOT deleted and no deletion event is emitted.
    expect(events.emit).not.toHaveBeenCalled();
    const deleteCalls = (db.delete as ReturnType<typeof vi.fn>).mock.calls;
    expect(deleteCalls).toHaveLength(0);
    expect(deletedTables).toHaveLength(0);
  });

  it("#2811: the WHOLE delete is ONE transaction — the solo org's removal rides it too, after the session revoke", async () => {
    const { svc, sessions, order, executors, selectExecutors, db, TX } = makeService({
      rowFound: true,
      orgRows: [{ id: ORG }],
      memberRows: [{ memberPayerId: PAYER, status: "active" }],
    });
    (sessions.revokeAllForPayer as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("revoke:sessions");
      return 1;
    });
    await svc.execute(PAYER, { ...CTX });
    expect(db.transaction).toHaveBeenCalledOnce();
    // Every read and every delete on the transaction's handle; nothing on the pool.
    expect(selectExecutors.length).toBeGreaterThan(0);
    expect(selectExecutors.every((e) => e === TX)).toBe(true);
    expect(executors.every((e) => e === TX)).toBe(true);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
    expect(order).toEqual([
      "revoke:sessions",
      "tx:begin",
      "delete:other", // payer_members of the solo org
      "delete:other", // the solo org
      "delete:payers",
      "delete:display_prefs",
      "erase:drive_contacts",
      "tx:commit",
    ]);
  });

  it("#2811: a row delete that fails rolls the solo org's removal back with it", async () => {
    const { svc, order, events } = makeService({
      rowFound: true,
      orgRows: [{ id: ORG }],
      memberRows: [{ memberPayerId: PAYER, status: "active" }],
      payerDeleteFails: true,
    });
    await expect(svc.execute(PAYER, { ...CTX })).rejects.toMatchObject({ code: "23503" });
    expect(order).toEqual([
      "tx:begin",
      "delete:other",
      "delete:other",
      "delete:payers",
      "tx:rollback",
    ]);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("#2746: erases the campus-drive contacts the login entered, in the SAME transaction as the row delete", async () => {
    const { svc, driveContacts, order, executors, TX } = makeService({
      rowFound: true,
      orgRows: [],
    });
    await svc.execute(PAYER, { ...CTX });
    // On the transaction's handle, not the pool: it commits only with the delete.
    expect(driveContacts.eraseEnteredBy).toHaveBeenCalledWith(PAYER, TX);
    expect(executors.at(-1)).toBe(TX);
    // The row delete first: the erasure's stamp lands just before the commit.
    expect(order).toEqual([
      "tx:begin",
      "delete:payers",
      "delete:display_prefs",
      "erase:drive_contacts",
      "tx:commit",
    ]);
  });

  it("#2837: deletes the LOGIN's display_prefs row on the transaction, after the payer row", async () => {
    const { svc, deletedTables, deleteWheres, executors, TX } = makeService({
      rowFound: true,
      orgRows: [],
    });
    await svc.execute(PAYER, { ...CTX });
    const at = deletedTables.indexOf(displayPrefs);
    // After the row delete, which waits for a theme PATCH holding the row (FOR KEY SHARE).
    expect(at).toBe(deletedTables.indexOf(payers) + 1);
    expect(executors[at]).toBe(TX);
    // The login's own kind and id: a worker or admin row with the same uuid is another login's.
    const where = new PgDialect().sqlToQuery(deleteWheres[at] as SQL);
    expect(where.sql).toBe(
      '("display_prefs"."subject_kind" = $1 and "display_prefs"."subject_id" = $2)',
    );
    expect(where.params).toEqual(["payer_user", PAYER]);
  });

  it("#2746: a payer row delete that fails aborts the transaction before the erasure, and emits nothing", async () => {
    const { svc, events, order } = makeService({
      rowFound: true,
      orgRows: [],
      payerDeleteFails: true,
    });
    await expect(svc.execute(PAYER, { ...CTX })).rejects.toMatchObject({ code: "23503" });
    // The failing delete aborts the transaction before any contact or theme row is touched.
    expect(order).toEqual(["tx:begin", "delete:payers", "tx:rollback"]);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("#2746: a refused deletion (shared org, already gone, revoke failure) erases no contact", async () => {
    const OTHER = "22222222-2222-4222-8222-222222222222";
    const shared = makeService({
      rowFound: true,
      orgRows: [{ id: ORG }],
      memberRows: [{ memberPayerId: OTHER, status: "active" }],
    });
    await expect(shared.svc.execute(PAYER, { ...CTX })).rejects.toBeInstanceOf(ConflictException);
    expect(shared.driveContacts.eraseEnteredBy).not.toHaveBeenCalled();

    const gone = makeService({ rowFound: false });
    await gone.svc.execute(PAYER, { ...CTX });
    expect(gone.driveContacts.eraseEnteredBy).not.toHaveBeenCalled();

    const redisDown = makeService({ rowFound: true, revokeThrows: true });
    await expect(redisDown.svc.execute(PAYER, { ...CTX })).rejects.toThrow("redis down");
    expect(redisDown.driveContacts.eraseEnteredBy).not.toHaveBeenCalled();
  });

  it("fails CLOSED when session revocation throws (no partial erasure)", async () => {
    const { svc, events, db } = makeService({ rowFound: true, revokeThrows: true });
    await expect(svc.execute(PAYER, { ...CTX })).rejects.toThrow("redis down");
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });
});
