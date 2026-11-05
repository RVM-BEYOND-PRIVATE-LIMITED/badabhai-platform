import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ConflictException } from "@nestjs/common";
import { payerOrgs } from "@badabhai/db";
import { PayerAccountDeletionService } from "./payer-account-deletion.service";

const CTX = { requestId: "req-1", correlationId: "corr-1" } as const;
const PAYER = "11111111-1111-4111-8111-111111111111";
const ORG = "33333333-3333-4333-8333-333333333333";

/** Chainable drizzle-select stub branching on the FROM table. */
function mockDb(orgRows: Array<{ id: string }>, memberRows: Array<unknown>) {
  const deletedTables: unknown[] = [];
  return {
    deletedTables,
    db: {
      select: vi.fn(() => ({
        from: vi.fn((table: unknown) => ({
          where: vi.fn(async () => (table === payerOrgs ? orgRows : memberRows)),
        })),
      })),
      delete: vi.fn((table: unknown) => {
        deletedTables.push(table);
        return { where: vi.fn(async () => undefined) };
      }),
    },
  };
}

function makeService(opts: {
  rowFound: boolean;
  orgRows?: Array<{ id: string }>;
  memberRows?: Array<unknown>;
  sessionsRevoked?: number;
  revokeThrows?: boolean;
}) {
  const { deletedTables, db } = mockDb(opts.orgRows ?? [], opts.memberRows ?? []);
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
  const svc = new PayerAccountDeletionService(
    db as never,
    payersRepo as never,
    sessions as never,
    events as never,
  );
  return { svc, payersRepo, sessions, events, deletedTables, db };
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
    // members + org + payer row removed (3 deletes).
    expect(deletedTables).toHaveLength(3);
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
    const { svc, events, db } = makeService({
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
  });

  it("fails CLOSED when session revocation throws (no partial erasure)", async () => {
    const { svc, events, db } = makeService({ rowFound: true, revokeThrows: true });
    await expect(svc.execute(PAYER, { ...CTX })).rejects.toThrow("redis down");
    expect(db.delete).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });
});
