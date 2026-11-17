import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import { PAYER_PHONE_PROOF_METHODS } from "@badabhai/db";
import { PayerPhoneProofMethodEnum } from "@badabhai/event-schema";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { PayersRepository } from "./payers.repository";
import {
  PHONE_PROOF_PHONE_UNIQUE,
  PayerPhoneProofsRepository,
  dropStalePhoneProof,
  isPhoneProofTableMissing,
  isPhoneProvenElsewhere,
} from "./payer-phone-proofs.repository";

/**
 * #2754 item 3 — the proof table's control flow without a database: the 42P01 fail-closed reads,
 * the savepoint that keeps a phone change alive before the migration, the unique-index refusal read
 * by its constraint NAME, and the phone-change write that drops the proof. The real index, cascade,
 * CHECK, RLS and concurrency are pinned by `payer-phone-proofs.db.test.ts` on a real Postgres.
 */
const PAYER = "aaaaaaaa-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

const missingTable = (): Error =>
  Object.assign(new Error("Failed query"), { cause: { code: "42P01" } });
const heldElsewhere = (constraint = PHONE_PROOF_PHONE_UNIQUE): Error =>
  Object.assign(new Error("Failed query"), {
    cause: { code: "23505", constraint_name: constraint },
  });

/**
 * A chainable fake: every builder method returns the same thenable, which resolves (or rejects) to
 * the scripted result of the statement kind that started it. `transaction(fn)` runs `fn` on the
 * same fake (and counts the nesting), the shape drizzle gives both a transaction and a savepoint.
 */
function fakeDb(script: {
  select?: () => unknown[];
  update?: () => unknown[];
  delete?: () => unknown[];
  execute?: (query: SQL) => unknown[];
}) {
  const log: string[] = [];
  const executed: SQL[] = [];
  let depth = 0;
  const thenable = (kind: string, produce: () => unknown) => {
    const proxy: object = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) => {
              try {
                return Promise.resolve(produce()).then(ok, fail);
              } catch (err) {
                return Promise.reject(err).then(ok, fail);
              }
            };
          }
          if (prop === "for") log.push(`${kind}.for`);
          return () => proxy;
        },
      },
    );
    log.push(kind);
    return proxy;
  };
  const db = {
    select: () => thenable("select", () => (script.select ?? (() => []))()),
    update: () => thenable("update", () => (script.update ?? (() => []))()),
    delete: () => thenable("delete", () => (script.delete ?? (() => []))()),
    execute: async (query: SQL) => {
      log.push("execute");
      executed.push(query);
      return (script.execute ?? (() => []))(query);
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      depth += 1;
      log.push(depth === 1 ? "begin" : "savepoint");
      try {
        return await fn(db);
      } finally {
        depth -= 1;
      }
    },
  };
  return { db: db as unknown as Database, log, executed };
}

const render = (query: SQL) => new PgDialect().sqlToQuery(query);

describe("the error readers", () => {
  it("42P01 is the missing table, wrapped by drizzle or not", () => {
    expect(isPhoneProofTableMissing(missingTable())).toBe(true);
    expect(isPhoneProofTableMissing(Object.assign(new Error("x"), { code: "42P01" }))).toBe(true);
    expect(isPhoneProofTableMissing(heldElsewhere())).toBe(false);
  });

  it("a 23505 is 'held elsewhere' ONLY on the phone-hash index — never the events index's", () => {
    expect(isPhoneProvenElsewhere(heldElsewhere())).toBe(true);
    expect(isPhoneProvenElsewhere(heldElsewhere("events_idempotency_key_uq"))).toBe(false);
    expect(
      isPhoneProvenElsewhere(Object.assign(new Error("x"), { cause: { code: "23505" } })),
    ).toBe(false);
    expect(isPhoneProvenElsewhere(missingTable())).toBe(false);
  });
});

describe("dropStalePhoneProof — the drop every phone write runs", () => {
  it("runs in a SAVEPOINT of the caller's transaction and reports what it dropped", async () => {
    const f = fakeDb({ delete: () => [{ payerId: PAYER }] });
    await f.db.transaction(async (tx) => {
      expect(await dropStalePhoneProof(tx as unknown as Database, PAYER, HASH)).toBe(1);
    });
    expect(f.log).toEqual(["begin", "savepoint", "delete"]);
  });

  it("42P01 (deploy ahead of the migration) is swallowed: nothing to drop, the phone change lives", async () => {
    const f = fakeDb({
      delete: () => {
        throw missingTable();
      },
    });
    await expect(dropStalePhoneProof(f.db, PAYER, HASH)).resolves.toBe(0);
  });

  it("any other error propagates (the phone change must not commit past it)", async () => {
    const f = fakeDb({
      delete: () => {
        throw new Error("deadlock detected");
      },
    });
    await expect(dropStalePhoneProof(f.db, PAYER, HASH)).rejects.toThrow("deadlock");
  });
});

describe("PayerPhoneProofsRepository.findProvenAccount — the ONLY way an SMS code resolves an account", () => {
  it("returns the payer of the joined proof row", async () => {
    const payer = { id: PAYER, status: "active", phoneHash: HASH };
    const f = fakeDb({ select: () => [{ payers: payer, payer_phone_proofs: { payerId: PAYER } }] });
    await expect(new PayerPhoneProofsRepository(f.db).findProvenAccount(HASH)).resolves.toBe(payer);
  });

  it("no proof (or a stale one the join drops) → undefined", async () => {
    const f = fakeDb({ select: () => [] });
    await expect(
      new PayerPhoneProofsRepository(f.db).findProvenAccount(HASH),
    ).resolves.toBeUndefined();
  });

  it("FAILS CLOSED on 42P01: no phone counts as proven, one warning per process", async () => {
    const f = fakeDb({
      select: () => {
        throw missingTable();
      },
    });
    const repo = new PayerPhoneProofsRepository(f.db);
    const warn = vi.spyOn(
      (repo as unknown as { logger: { warn: (message: string) => void } }).logger,
      "warn",
    );
    await expect(repo.findProvenAccount(HASH)).resolves.toBeUndefined();
    await expect(repo.findProvenAccount(HASH)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("42P01");
  });

  it("any other error propagates", async () => {
    const f = fakeDb({
      select: () => {
        throw new Error("connection reset");
      },
    });
    await expect(new PayerPhoneProofsRepository(f.db).findProvenAccount(HASH)).rejects.toThrow(
      "connection reset",
    );
  });
});

describe("PayerPhoneProofsRepository.isCurrentPhoneProven — GET /payer/me/phone-proof", () => {
  it("true when the joined proof row names the account's current phone; false when none does", async () => {
    await expect(
      new PayerPhoneProofsRepository(
        fakeDb({ select: () => [{ payerId: PAYER }] }).db,
      ).isCurrentPhoneProven(PAYER),
    ).resolves.toBe(true);
    await expect(
      new PayerPhoneProofsRepository(fakeDb({ select: () => [] }).db).isCurrentPhoneProven(PAYER),
    ).resolves.toBe(false);
  });

  it("42P01 (the table not migrated) reads as false — never a 503 — with one warning", async () => {
    const f = fakeDb({
      select: () => {
        throw missingTable();
      },
    });
    const repo = new PayerPhoneProofsRepository(f.db);
    const warn = vi.spyOn(
      (repo as unknown as { logger: { warn: (message: string) => void } }).logger,
      "warn",
    );
    await expect(repo.isCurrentPhoneProven(PAYER)).resolves.toBe(false);
    await expect(repo.isCurrentPhoneProven(PAYER)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("any other error propagates", async () => {
    const f = fakeDb({
      select: () => {
        throw new Error("connection reset");
      },
    });
    await expect(new PayerPhoneProofsRepository(f.db).isCurrentPhoneProven(PAYER)).rejects.toThrow(
      "connection reset",
    );
  });
});

describe("PayerPhoneProofsRepository.recordSmsProof — the verify write", () => {
  it("locks the payer row FOR UPDATE, upserts the proof from it, runs the event IN the transaction", async () => {
    const f = fakeDb({ select: () => [{ phoneHash: HASH }], execute: () => [{ payer_id: PAYER }] });
    const onProven = vi.fn(async (_tx: Database) => undefined);
    await expect(
      new PayerPhoneProofsRepository(f.db).recordSmsProof(PAYER, HASH, onProven),
    ).resolves.toBe("proven");
    expect(f.log).toEqual(["begin", "select", "select.for", "execute"]);
    expect(onProven).toHaveBeenCalledTimes(1);
    const { sql, params } = render(f.executed[0]!);
    expect(sql).toContain("INSERT INTO payer_phone_proofs");
    expect(sql).toContain("ON CONFLICT (payer_id) DO UPDATE");
    expect(sql).toContain("p.phone_hash = $");
    expect(params).toEqual(["sms_code", PAYER, HASH]);
  });

  it("the phone moved since the code was sent → phone_changed, nothing written, no event", async () => {
    const f = fakeDb({ select: () => [{ phoneHash: OTHER_HASH }] });
    const onProven = vi.fn(async () => undefined);
    await expect(
      new PayerPhoneProofsRepository(f.db).recordSmsProof(PAYER, HASH, onProven),
    ).resolves.toBe("phone_changed");
    expect(f.log).not.toContain("execute");
    expect(onProven).not.toHaveBeenCalled();
  });

  it("the account is gone → phone_changed (nothing to prove a phone for)", async () => {
    const f = fakeDb({ select: () => [] });
    await expect(
      new PayerPhoneProofsRepository(f.db).recordSmsProof(PAYER, HASH, vi.fn()),
    ).resolves.toBe("phone_changed");
  });

  it("another account holds the proof (the unique index) → held_elsewhere, no event", async () => {
    const f = fakeDb({
      select: () => [{ phoneHash: HASH }],
      execute: () => {
        throw heldElsewhere();
      },
    });
    const onProven = vi.fn(async () => undefined);
    await expect(
      new PayerPhoneProofsRepository(f.db).recordSmsProof(PAYER, HASH, onProven),
    ).resolves.toBe("held_elsewhere");
    expect(onProven).not.toHaveBeenCalled();
  });

  it("a 23505 from the EVENT insert is not mistaken for the phone index (it propagates)", async () => {
    const f = fakeDb({ select: () => [{ phoneHash: HASH }], execute: () => [{ payer_id: PAYER }] });
    await expect(
      new PayerPhoneProofsRepository(f.db).recordSmsProof(PAYER, HASH, async () => {
        throw heldElsewhere("events_idempotency_key_uq");
      }),
    ).rejects.toThrow();
  });

  it("42P01 propagates (the service answers 503)", async () => {
    const f = fakeDb({
      select: () => [{ phoneHash: HASH }],
      execute: () => {
        throw missingTable();
      },
    });
    await expect(
      new PayerPhoneProofsRepository(f.db).recordSmsProof(PAYER, HASH, vi.fn()),
    ).rejects.toSatisfy(isPhoneProofTableMissing);
  });
});

describe("PayerPhoneProofsRepository.recordImportedProof — #2754 item 6's seam (no caller yet)", () => {
  it("writes method campus_import, in a SAVEPOINT of the import's transaction", async () => {
    const f = fakeDb({ execute: () => [{ payer_id: PAYER }] });
    await f.db.transaction(async (tx) => {
      await expect(
        new PayerPhoneProofsRepository(f.db).recordImportedProof(
          PAYER,
          HASH,
          tx as unknown as Database,
        ),
      ).resolves.toBe("proven");
    });
    expect(f.log).toEqual(["begin", "savepoint", "execute"]);
    expect(render(f.executed[0]!).params).toEqual(["campus_import", PAYER, HASH]);
  });

  it("a phone the account does not currently hold writes nothing → phone_changed", async () => {
    const f = fakeDb({ execute: () => [] });
    await expect(
      new PayerPhoneProofsRepository(f.db).recordImportedProof(PAYER, HASH, f.db),
    ).resolves.toBe("phone_changed");
  });

  it("a phone another account has proven → held_elsewhere (the import's exception list), batch alive", async () => {
    const f = fakeDb({
      execute: () => {
        throw heldElsewhere();
      },
    });
    await expect(
      new PayerPhoneProofsRepository(f.db).recordImportedProof(PAYER, HASH, f.db),
    ).resolves.toBe("held_elsewhere");
  });

  it("the method set is the same in the table CHECK, the db constant and the event enum", () => {
    expect([...PAYER_PHONE_PROOF_METHODS]).toEqual(PayerPhoneProofMethodEnum.options);
  });
});

describe("PayersRepository.updateContact — a phone change drops the proof in the same transaction", () => {
  // Real crypto with deterministic test secrets (the payers.repository.test.ts pair).
  const pii = new PiiCryptoService({
    PII_HASH_PEPPER: "test-pepper",
    PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  } as never);
  const NEW_PHONE = "+919812345678";
  const newHash = pii.hashPhone(NEW_PHONE);

  it("a NEW number: lock + read the old hash, write, drop the stale proof (savepoint) → phoneChanged", async () => {
    let selects = 0;
    const f = fakeDb({
      select: () => (selects++ === 0 ? [{ phoneHash: OTHER_HASH }] : []),
      update: () => [{ id: PAYER, phoneHash: newHash }],
      delete: () => [{ payerId: PAYER }],
    });
    const out = await new PayersRepository(f.db, pii).updateContact(PAYER, { phone: NEW_PHONE });
    expect(out).toMatchObject({ phoneChanged: true, row: { id: PAYER } });
    expect(f.log).toEqual(["begin", "select", "select.for", "update", "savepoint", "delete"]);
  });

  it("the SAME number saved again → phoneChanged false (the drop keeps a proof that names it)", async () => {
    const f = fakeDb({
      select: () => [{ phoneHash: newHash }],
      update: () => [{ id: PAYER, phoneHash: newHash }],
      delete: () => [],
    });
    const out = await new PayersRepository(f.db, pii).updateContact(PAYER, { phone: NEW_PHONE });
    expect(out?.phoneChanged).toBe(false);
  });

  it("before the migration (42P01 in the savepoint) the phone change still succeeds", async () => {
    const f = fakeDb({
      select: () => [{ phoneHash: OTHER_HASH }],
      update: () => [{ id: PAYER, phoneHash: newHash }],
      delete: () => {
        throw missingTable();
      },
    });
    await expect(
      new PayersRepository(f.db, pii).updateContact(PAYER, { phone: NEW_PHONE }),
    ).resolves.toMatchObject({ phoneChanged: true });
  });

  it("inside the caller's transaction it joins it (no second BEGIN)", async () => {
    const f = fakeDb({
      select: () => [{ phoneHash: OTHER_HASH }],
      update: () => [{ id: PAYER, phoneHash: newHash }],
    });
    await f.db.transaction(async (tx) => {
      await new PayersRepository(f.db, pii).updateContact(
        PAYER,
        { phone: NEW_PHONE },
        tx as unknown as Database,
      );
    });
    expect(f.log.filter((l) => l === "begin")).toHaveLength(1);
  });

  it("an unknown id → undefined, nothing written", async () => {
    const f = fakeDb({ select: () => [] });
    await expect(
      new PayersRepository(f.db, pii).updateContact(PAYER, { phone: NEW_PHONE }),
    ).resolves.toBeUndefined();
    expect(f.log).not.toContain("update");
  });

  it("a name-only edit touches no proof and opens no transaction", async () => {
    const f = fakeDb({ update: () => [{ id: PAYER }] });
    const out = await new PayersRepository(f.db, pii).updateContact(PAYER, { orgName: "New Ltd" });
    expect(out?.phoneChanged).toBe(false);
    expect(f.log).toEqual(["update"]);
  });

  it("update() is updateContact without the bit (the admin rename path is unchanged)", async () => {
    const f = fakeDb({ update: () => [{ id: PAYER }] });
    await expect(
      new PayersRepository(f.db, pii).update(PAYER, { orgName: "New Ltd" }),
    ).resolves.toEqual({ id: PAYER });
  });
});
