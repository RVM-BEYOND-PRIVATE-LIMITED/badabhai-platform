import "reflect-metadata";
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql as dsql } from "drizzle-orm";
import { loadServerConfig, type ServerConfig } from "@badabhai/config";
import { createDbClient, type Database, type DbClient } from "@badabhai/db";

import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { PayersRepository } from "./payers.repository";
import { PayerPhoneProofsRepository } from "./payer-phone-proofs.repository";

/**
 * #2754 item 3 — `payer_phone_proofs` against a REAL Postgres (the throwaway CI service, or a
 * throwaway local database; never a shared one). What only a database can prove:
 *
 *  - ONE ACCOUNT PER PROVEN PHONE: the unique index refuses a second account's proof, and two
 *    concurrent proofs of one phone end with exactly one winner;
 *  - the SMS sign-in lookup resolves only a proof that still names the account's CURRENT phone;
 *  - a phone change (`PayersRepository.updateContact`) drops the proof IN its transaction (and a
 *    rolled-back change keeps it), and a phone change racing a proof never leaves a stale proof;
 *  - the method CHECK, the payer FK and its ON DELETE CASCADE, archive leaving the proof alone;
 *  - the import's savepoint (`recordImportedProof`) keeps the batch's transaction alive;
 *  - RLS enabled AND forced, no policy, and no client role holding any privilege.
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

const TAG = randomUUID().slice(0, 8);
/** A fresh, valid Indian mobile per call, so a rerun never meets an earlier run's rows. */
const phone = () => `+9198${String(randomInt(0, 100_000_000)).padStart(8, "0")}`;

describe.skipIf(!RUN)("payer_phone_proofs against Postgres (#2754 item 3)", () => {
  let client!: DbClient;
  let config!: ServerConfig;
  let pii!: PiiCryptoService;
  let payers!: PayersRepository;
  let proofs!: PayerPhoneProofsRepository;
  let events!: EventsService;
  const created: string[] = [];

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 6 });
    config = loadServerConfig({ NODE_ENV: "test" });
    pii = new PiiCryptoService({
      PII_HASH_PEPPER: `phone-proof-${TAG}`,
      PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    } as unknown as ServerConfig);
    payers = new PayersRepository(client.db, pii);
    proofs = new PayerPhoneProofsRepository(client.db);
    events = new EventsService(new EventsRepository(client.db), config);
  }, 60_000);

  afterAll(async () => {
    if (!client) return;
    const { sql } = client;
    try {
      await sql`
        DELETE FROM events
         WHERE event_name = 'payer.phone_proven' AND payload->>'payer_id' = ANY(${created}::text[])`;
      // Proofs cascade from payers.
      await sql`DELETE FROM payers WHERE id = ANY(${created}::uuid[])`;
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  /** A company account holding `number` (unproven). */
  async function company(number: string): Promise<string> {
    const { id } = await payers.create({
      role: "employer",
      orgName: `Proof Co ${TAG}`,
      phone: number,
    });
    created.push(id);
    return id;
  }

  const emitProven = (payerId: string) => async (tx: Database) => {
    await events.emit({
      event_name: "payer.phone_proven",
      actor: { actor_type: "payer", actor_id: payerId },
      subject: { subject_type: "payer", subject_id: payerId },
      payload: { payer_id: payerId, method: "sms_code" },
      tx,
      correlationId: randomUUID(),
      requestId: `phone-proof-db-${TAG}`,
    });
  };

  const proofOf = async (payerId: string) =>
    (
      await client.sql<{ phone_hash: string; method: string }[]>`
        SELECT phone_hash, method FROM payer_phone_proofs WHERE payer_id = ${payerId}::uuid`
    )[0];

  const provenEvents = async (payerId: string) =>
    (
      await client.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM events
         WHERE event_name = 'payer.phone_proven' AND payload->>'payer_id' = ${payerId}`
    )[0]!.n;

  const code = (r: unknown) =>
    (r as { code?: string }).code ?? (r as { cause?: { code?: string } }).cause?.code;

  it("an unproven phone resolves NO account; a proof makes it resolve exactly that one, with its event", async () => {
    const number = phone();
    const hash = pii.hashPhone(number);
    const a = await company(number);
    expect(await proofs.findProvenAccount(hash)).toBeUndefined();

    expect(await proofs.recordSmsProof(a, hash, emitProven(a))).toBe("proven");
    expect(await proofOf(a)).toEqual({ phone_hash: hash, method: "sms_code" });
    expect((await proofs.findProvenAccount(hash))?.id).toBe(a);
    expect(await provenEvents(a)).toBe(1);
  });

  it("ONE ACCOUNT PER PROVEN PHONE: a second account on the same phone cannot prove it (no row, no event)", async () => {
    const number = phone();
    const hash = pii.hashPhone(number);
    const holder = await company(number);
    const planted = await company(number); // the same phone, typed on another account
    expect(await proofs.recordSmsProof(holder, hash, emitProven(holder))).toBe("proven");
    expect(await proofs.recordSmsProof(planted, hash, emitProven(planted))).toBe("held_elsewhere");
    expect(await proofOf(planted)).toBeUndefined();
    expect(await provenEvents(planted)).toBe(0);
    // The planted duplicate locks nobody out: the phone still signs in the holder.
    expect((await proofs.findProvenAccount(hash))?.id).toBe(holder);
    // …and the raw index refuses a second row for the hash whoever writes it.
    const raw = await client.sql`
      INSERT INTO payer_phone_proofs (payer_id, phone_hash, method)
      VALUES (${planted}::uuid, ${hash}, 'sms_code')`.catch((e: unknown) => e);
    expect(code(raw)).toBe("23505");
  });

  it("two CONCURRENT proofs of one phone by two accounts: exactly one wins", async () => {
    const number = phone();
    const hash = pii.hashPhone(number);
    const a = await company(number);
    const b = await company(number);
    const outcomes = await Promise.all([
      proofs.recordSmsProof(a, hash, emitProven(a)),
      proofs.recordSmsProof(b, hash, emitProven(b)),
    ]);
    expect([...outcomes].sort()).toEqual(["held_elsewhere", "proven"]);
    const rows = await client.sql<{ payer_id: string }[]>`
      SELECT payer_id FROM payer_phone_proofs WHERE phone_hash = ${hash}`;
    expect(rows).toHaveLength(1);
    expect((await proofs.findProvenAccount(hash))?.id).toBe(rows[0]!.payer_id);
    expect((await provenEvents(a)) + (await provenEvents(b))).toBe(1);
  });

  it("A PHONE CHANGE DROPS THE PROOF in its transaction; the stale hash resolves nobody", async () => {
    const number = phone();
    const hash = pii.hashPhone(number);
    const a = await company(number);
    await proofs.recordSmsProof(a, hash, emitProven(a));

    // The same number saved again keeps the proof.
    expect((await payers.updateContact(a, { phone: number }))?.phoneChanged).toBe(false);
    expect(await proofOf(a)).toBeDefined();

    const next = phone();
    expect((await payers.updateContact(a, { phone: next }))?.phoneChanged).toBe(true);
    expect(await proofOf(a)).toBeUndefined();
    expect(await proofs.findProvenAccount(hash)).toBeUndefined();
    expect(await proofs.findProvenAccount(pii.hashPhone(next))).toBeUndefined();
    // The old number is free again: another account holding it may now prove it.
    const b = await company(number);
    expect(await proofs.recordSmsProof(b, hash, emitProven(b))).toBe("proven");
  });

  it("GET /payer/me/phone-proof's read: false unproven, true once proven, false after a phone change", async () => {
    const number = phone();
    const hash = pii.hashPhone(number);
    const a = await company(number);
    expect(await proofs.isCurrentPhoneProven(a)).toBe(false);
    await proofs.recordSmsProof(a, hash, emitProven(a));
    expect(await proofs.isCurrentPhoneProven(a)).toBe(true);
    await payers.updateContact(a, { phone: phone() });
    expect(await proofs.isCurrentPhoneProven(a)).toBe(false);
    // A stale row left behind by a writer that skipped the drop reads false too.
    await proofs.recordSmsProof(
      a,
      (
        await client.sql<{ h: string }[]>`
      SELECT phone_hash AS h FROM payers WHERE id = ${a}::uuid`
      )[0]!.h,
      emitProven(a),
    );
    expect(await proofs.isCurrentPhoneProven(a)).toBe(true);
    await client.sql`UPDATE payers SET phone_hash = ${`stale-status-${TAG}`} WHERE id = ${a}::uuid`;
    expect(await proofs.isCurrentPhoneProven(a)).toBe(false);
    // No account at all.
    expect(await proofs.isCurrentPhoneProven(randomUUID())).toBe(false);
  });

  it("a ROLLED-BACK phone change keeps the proof (the drop is in the change's transaction)", async () => {
    const number = phone();
    const hash = pii.hashPhone(number);
    const a = await company(number);
    await proofs.recordSmsProof(a, hash, emitProven(a));
    await expect(
      payers.withTransaction(async (tx) => {
        await payers.updateContact(a, { phone: phone() }, tx);
        throw new Error("abort after the change");
      }),
    ).rejects.toThrow("abort after the change");
    expect(await proofOf(a)).toEqual({ phone_hash: hash, method: "sms_code" });
    expect((await proofs.findProvenAccount(hash))?.id).toBe(a);
  });

  it("a stale proof (left by a writer that skipped the drop) is IGNORED by the sign-in lookup", async () => {
    const number = phone();
    const hash = pii.hashPhone(number);
    const a = await company(number);
    await proofs.recordSmsProof(a, hash, emitProven(a));
    // Simulate a phone write that bypassed updateContact.
    await client.sql`UPDATE payers SET phone_hash = ${`stale-${TAG}`} WHERE id = ${a}::uuid`;
    expect(await proofs.findProvenAccount(hash)).toBeUndefined();
    // …and a verify for the old hash writes nothing: the phone moved.
    expect(await proofs.recordSmsProof(a, hash, emitProven(a))).toBe("phone_changed");
  });

  it("a phone change RACING a proof never leaves a proof that names another number", async () => {
    for (let round = 0; round < 5; round += 1) {
      const number = phone();
      const hash = pii.hashPhone(number);
      const a = await company(number);
      await Promise.all([
        proofs.recordSmsProof(a, hash, emitProven(a)),
        payers.updateContact(a, { phone: phone() }),
      ]);
      const [row] = await client.sql<{ current: string | null; proven: string | null }[]>`
        SELECT p.phone_hash AS current, pp.phone_hash AS proven
          FROM payers p LEFT JOIN payer_phone_proofs pp ON pp.payer_id = p.id
         WHERE p.id = ${a}::uuid`;
      // Either no proof survived, or it names the CURRENT number — never the one left behind.
      if (row!.proven !== null) expect(row!.proven).toBe(row!.current);
    }
  });

  it("archive leaves the proof in place (the sign-in doors refuse the status, a restore returns it)", async () => {
    const number = phone();
    const hash = pii.hashPhone(number);
    const a = await company(number);
    await proofs.recordSmsProof(a, hash, emitProven(a));
    await client.sql`
      UPDATE payers SET previous_status = status, status = 'archived' WHERE id = ${a}::uuid`;
    expect(await proofOf(a)).toBeDefined();
    expect((await proofs.findProvenAccount(hash))?.status).toBe("archived");
  });

  it("the account's hard delete cascades its proof (erasure)", async () => {
    const number = phone();
    const hash = pii.hashPhone(number);
    const a = await company(number);
    await proofs.recordSmsProof(a, hash, emitProven(a));
    await client.sql`DELETE FROM payers WHERE id = ${a}::uuid`;
    expect(await proofOf(a)).toBeUndefined();
    expect(await proofs.findProvenAccount(hash)).toBeUndefined();
  });

  it("recordImportedProof: campus_import, and a phone held elsewhere rolls back ALONE (the batch lives)", async () => {
    const taken = phone();
    const holder = await company(taken);
    await proofs.recordSmsProof(holder, pii.hashPhone(taken), emitProven(holder));
    const clash = await company(taken);
    const fresh = phone();
    const imported = await company(fresh);

    const outcome = await payers.withTransaction(async (tx) => {
      const first = await proofs.recordImportedProof(clash, pii.hashPhone(taken), tx);
      // The batch's transaction is still usable after the refused savepoint.
      const second = await proofs.recordImportedProof(imported, pii.hashPhone(fresh), tx);
      const mismatch = await proofs.recordImportedProof(imported, pii.hashPhone(phone()), tx);
      return { first, second, mismatch };
    });
    expect(outcome).toEqual({
      first: "held_elsewhere",
      second: "proven",
      mismatch: "phone_changed",
    });
    expect(await proofOf(imported)).toEqual({
      phone_hash: pii.hashPhone(fresh),
      method: "campus_import",
    });
    expect(await proofOf(clash)).toBeUndefined();
  });

  it("the method CHECK and the payer FK", async () => {
    const number = phone();
    const a = await company(number);
    const bad = await client.sql`
      INSERT INTO payer_phone_proofs (payer_id, phone_hash, method)
      VALUES (${a}::uuid, ${`chk-${TAG}`}, 'whatsapp')`.catch((e: unknown) => e);
    expect(code(bad)).toBe("23514");
    const orphan = await client.sql`
      INSERT INTO payer_phone_proofs (payer_id, phone_hash, method)
      VALUES (${randomUUID()}::uuid, ${`orphan-${TAG}`}, 'sms_code')`.catch((e: unknown) => e);
    expect(code(orphan)).toBe("23503");
  });

  it("RLS is ENABLED and FORCED, with no policy, and no client role holds any privilege", async () => {
    const [rls] = await client.sql<{ enabled: boolean; forced: boolean }[]>`
      SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
        FROM pg_class WHERE oid = 'public.payer_phone_proofs'::regclass`;
    expect(rls).toEqual({ enabled: true, forced: true });
    const [policies] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'payer_phone_proofs'`;
    expect(policies!.n).toBe(0);
    const [publicGrants] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM information_schema.role_table_grants
       WHERE table_name = 'payer_phone_proofs' AND grantee = 'PUBLIC'`;
    expect(publicGrants!.n).toBe(0);
    const roles = await client.sql<{ rolname: string }[]>`
      SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')`;
    expect(roles.map((r) => r.rolname).sort()).toEqual(["anon", "authenticated", "service_role"]);
    for (const { rolname } of roles) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const [row] = await client.db.execute<{ has: boolean }>(
          dsql`SELECT has_table_privilege(${rolname}, 'public.payer_phone_proofs', ${priv}) AS has`,
        );
        expect(row!.has, `${rolname} ${priv}`).toBe(false);
      }
    }
  });
});
