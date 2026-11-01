import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import type { Database } from "@badabhai/db";
import { PayerOrgsRepository } from "./payer-orgs.repository";

const PHONE_HASH = "phone-hash-for-tests";

/**
 * #2497 — a phone-only founder's owner member row carries NULL email columns (the
 * (org_id, email_hash) dedup key cannot work without an email). Idempotency comes
 * from an explicit check-then-insert inside the phone-hash advisory lock.
 */
function makeDb(payerRow: Record<string, unknown>) {
  const memberInserts: unknown[] = [];
  const tx = {
    execute: vi.fn(async () => [] as unknown[]),
    select: () => ({
      from: () => ({
        // No existing active owner member in this fixture.
        where: () => ({ limit: async () => [] as unknown[] }),
      }),
    }),
    insert: () => ({
      values: (v: unknown) => {
        memberInserts.push(v);
        return {};
      },
    }),
  };
  const db = {
    // select() with no projection = the payer row read; with a projection = the org id read.
    select: (cols?: unknown) => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            cols === undefined ? [payerRow] : ([{ id: "org-9" }] as unknown[]),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({ onConflictDoNothing: async () => [] as unknown[] }),
    }),
    transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as Database;
  return { db, tx, memberInserts };
}

const phoneOnlyPayer = {
  id: "payer-1",
  emailEnc: null,
  emailHash: null,
  phoneHash: PHONE_HASH,
  orgNameEnc: "enc-org",
};

describe("PayerOrgsRepository.ensureSoloOrg for a phone-only founder (#2497)", () => {
  it("inserts the owner member with NULL email columns inside the phone-hash advisory lock", async () => {
    const { db, tx, memberInserts } = makeDb(phoneOnlyPayer);
    const repo = new PayerOrgsRepository(db);
    const res = await repo.ensureSoloOrg("payer-1");

    expect(res).toEqual({ orgId: "org-9", orgRole: "owner" });
    expect(memberInserts).toHaveLength(1);
    expect(memberInserts[0]).toMatchObject({
      orgId: "org-9",
      memberPayerId: "payer-1",
      emailEnc: null,
      emailHash: null,
      orgRole: "owner",
      status: "active",
    });
    // Serialized on the phone-hash advisory lock (the opaque hash, never the phone).
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });

  it("skips the insert when an active owner member already exists (idempotent)", async () => {
    const { db, memberInserts } = makeDb(phoneOnlyPayer);
    // Second ensure: the member read now finds the first ensure's row.
    let calls = 0;
    const txSelect = async () => {
      calls++;
      return calls > 1 ? [{ id: "member-1" }] : [];
    };
    const db2 = {
      ...(db as unknown as Record<string, unknown>),
      transaction: async (fn: (t: unknown) => Promise<unknown>) =>
        fn({
          execute: async () => [],
          select: () => ({ from: () => ({ where: () => ({ limit: txSelect }) }) }),
          insert: () => ({
            values: (v: unknown) => {
              memberInserts.push(v);
              return {};
            },
          }),
        }),
    } as unknown as Database;
    const repo = new PayerOrgsRepository(db2);
    await repo.ensureSoloOrg("payer-1");
    await repo.ensureSoloOrg("payer-1");
    expect(memberInserts).toHaveLength(1);
  });
});
