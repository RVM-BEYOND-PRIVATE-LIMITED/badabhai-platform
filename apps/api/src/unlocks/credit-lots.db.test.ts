import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Logger } from "@nestjs/common";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadServerConfig } from "@badabhai/config";
import { createDbClient, type DbClient } from "@badabhai/db";
import { DEFAULT_MATCH_CONFIG } from "@badabhai/match-engine";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { AdminActionsRepository } from "../admin/admin-actions.repository";
import { ConsentRepository } from "../consent/consent.repository";
import { EventsRepository } from "../events/events.repository";
import { EventsService } from "../events/events.service";
import { FreeTierService } from "../match/free-tier.service";
import { InstituteLinkRepository } from "../campus-link/institute-link.repository";
import { InstituteOpenGate } from "../campus-link/institute-open-gate.service";
import { PayerOrgsRepository } from "../payers/payer-orgs.repository";
import { PayersRepository } from "../payers/payers.repository";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { WorkersRepository } from "../workers/workers.repository";
import { CreditLotExpirySweepProcessor } from "./credit-lot-expiry-sweep.processor";
import { PaymentGateway } from "./payment-gateway";
import { UnlockService } from "./unlocks.service";
import { UnlocksRepository, type StoredWalletKey } from "./unlocks.repository";

/**
 * #2749 items 2-4 — EXPIRING CREDIT LOTS against real Postgres (migration 0170).
 *
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api test credit-lots.db
 *
 * What only a real database proves: the wallet row lock serialising concurrent spends, the
 * CHECKs and unique keys, the spend order evaluating in SQL, and the expiry writing one ledger
 * line per lot ever. Every writer is driven through its REAL code (the repository the unlock
 * path, the mock pack and the Razorpay settle use; the admin grant; the free-tier service; the
 * sweep processor), and after each scenario the invariant is checked:
 *
 *   payer_credits.balance = Σ open credits_remaining   (always)
 *   payer_credits.balance = Σ credit_ledger.delta      (when no raw SQL moved the balance)
 *
 * `payer.credits_expired` rows are asserted from the real `events` table: the sweep's (one per lot,
 * on the wallet's transaction, never a second) and the contact open's (through the real
 * UnlockService, on the unlock transaction). The #2749 review's F-1/F-3 fix is proven the same
 * way: a wallet whose credits are all past due is refused with nothing written, worker or not.
 *
 * Nothing in #2749 PR 1 writes an `expires_at`, so the scenarios that need one set it by SQL.
 * Wallet keys are fresh uuids (no `payers` row is needed: the wallet tables carry no FK to it);
 * every row is deleted afterwards. PII-free: ids and integers only.
 */
const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

describe.skipIf(!RUN)("expiring credit lots (#2749) — against real Postgres", () => {
  let client: DbClient;
  let repo: UnlocksRepository;
  const wallets: string[] = [];
  const orderIds: string[] = [];
  const workerIds: string[] = [];
  const TAG = randomUUID().slice(0, 8);
  const CTX: RequestContext = { correlationId: randomUUID(), requestId: `credit-lots-db-${TAG}` };

  /** A fresh wallet key, registered for cleanup. */
  function wallet(): TenantKey {
    const id = randomUUID();
    wallets.push(id);
    return id as TenantKey;
  }

  beforeAll(() => {
    // A pool larger than the concurrency scenario, so its transactions really overlap.
    client = createDbClient(DATABASE_URL, { max: 14 });
    repo = new UnlocksRepository(client.db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (!client) return;
    try {
      const { sql } = client;
      // Ledger lines name lots, and lots name orders: delete in that order.
      await sql`
        DELETE FROM events WHERE event_name = 'payer.credits_expired'
          AND payload->>'payer_id' = ANY(${wallets}::text[])`;
      await sql`DELETE FROM events WHERE correlation_id = ${CTX.correlationId}::uuid`;
      await sql`DELETE FROM unlocks WHERE payer_id = ANY(${wallets}::uuid[])`;
      await sql`DELETE FROM worker_consents WHERE worker_id = ANY(${workerIds}::uuid[])`;
      await sql`DELETE FROM workers WHERE id = ANY(${workerIds}::uuid[])`;
      await sql`DELETE FROM credit_ledger WHERE payer_id = ANY(${wallets}::uuid[])`;
      await sql`DELETE FROM credit_lots WHERE payer_id = ANY(${wallets}::uuid[])`;
      await sql`DELETE FROM payment_orders WHERE id = ANY(${orderIds}::uuid[])`;
      await sql`DELETE FROM payer_credits WHERE payer_id = ANY(${wallets}::uuid[])`;
    } finally {
      await client.sql.end({ timeout: 5 });
    }
  });

  // -------------------------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------------------------

  async function pack(w: TenantKey, credits: number, packCode = "pack_test"): Promise<string> {
    await repo.creditPack({
      payerId: w,
      credits,
      reason: "pack_purchase",
      packCode,
      paymentRef: null,
      priceInr: credits * 10,
    });
    const [lot] = await client.sql<{ id: string }[]>`
      SELECT id FROM credit_lots WHERE payer_id = ${w}::uuid ORDER BY created_at DESC, id DESC LIMIT 1`;
    return lot!.id;
  }

  async function setExpiry(lotId: string, interval: string | null): Promise<void> {
    if (interval === null) {
      await client.sql`UPDATE credit_lots SET expires_at = NULL WHERE id = ${lotId}::uuid`;
    } else {
      await client.sql`
        UPDATE credit_lots SET expires_at = now() + ${interval}::interval WHERE id = ${lotId}::uuid`;
    }
  }

  /** One contact open's money half, exactly as UnlockService runs it: debit, then the line. */
  async function spendRaw(w: TenantKey) {
    return repo.withTransaction(async (tx) => {
      const debit = await repo.tryDebit(tx, w, 1);
      if (debit !== undefined) {
        await repo.appendLedger(tx, {
          payerId: w,
          delta: -1,
          reason: "unlock_debit",
          lotId: debit.lotId,
        });
      }
      return debit;
    });
  }

  /** {@link spendRaw}, as "what was spent": the balance and the lot, or undefined for none. */
  async function spend(w: TenantKey): Promise<{ balanceAfter: number; lotId: string } | undefined> {
    const debit = await spendRaw(w);
    return debit !== undefined
      ? { balanceAfter: debit.balanceAfter, lotId: debit.lotId }
      : undefined;
  }

  /** Every row a wallet owns (ledger, lots, balance) and its credits_expired count, as text. */
  async function snapshot(w: string): Promise<string> {
    const { sql } = client;
    const ledger = await sql`SELECT * FROM credit_ledger WHERE payer_id = ${w}::uuid ORDER BY id`;
    const lots = await sql`SELECT * FROM credit_lots WHERE payer_id = ${w}::uuid ORDER BY id`;
    const balance = await sql`SELECT * FROM payer_credits WHERE payer_id = ${w}::uuid`;
    const [events] = await sql`
      SELECT count(*)::int AS n FROM events
      WHERE event_name = 'payer.credits_expired' AND payload->>'payer_id' = ${w}`;
    return JSON.stringify({ ledger: [...ledger], lots: [...lots], balance: [...balance], events });
  }

  /** A worker who can be opened (consented to employer sharing), registered for cleanup. */
  async function consentingWorker(pii: PiiCryptoService): Promise<string> {
    const id = randomUUID();
    const phone = `+9198${String(workerIds.length).padStart(8, "0")}`;
    await client.sql`
      INSERT INTO workers (id, phone_e164, phone_hash, status)
      VALUES (${id}::uuid, ${pii.encrypt(phone)}, ${`hash:2749-${TAG}-${id}`}, 'active')`;
    await client.sql`
      INSERT INTO worker_consents (worker_id, consent_version, purposes, accepted_at)
      VALUES (${id}::uuid, '2026-06-01',
              ${JSON.stringify(["profiling", "employer_sharing", "employer_messaging"])}::jsonb, now())`;
    workerIds.push(id);
    return id;
  }

  /** The REAL contact-open service on this database (tenancy off: the payer is its own wallet). */
  function unlockService(): { svc: UnlockService; pii: PiiCryptoService } {
    const config = loadServerConfig({ NODE_ENV: "test", UNLOCK_LATENCY_TARGET_MS: "0" });
    const pii = new PiiCryptoService(config);
    const events = new EventsService(new EventsRepository(client.db), config);
    const gateway = new PaymentGateway(repo, config, {} as never, {} as never);
    const svc = new UnlockService(
      repo,
      new ConsentRepository(client.db),
      new WorkersRepository(client.db),
      pii,
      gateway,
      events,
      config,
      { add: async () => undefined } as never, // the referral-bonus queue (post-commit)
      { get: async () => DEFAULT_MATCH_CONFIG } as never,
      new PayersRepository(client.db, pii),
      new PayerTenantScopeService(config, new PayerOrgsRepository(client.db)),
      new InstituteOpenGate(new InstituteLinkRepository(client.db), {} as never),
    );
    return { svc, pii };
  }

  async function expiredEvents(w: string): Promise<{ payload: Record<string, unknown> }[]> {
    return client.sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM events WHERE event_name = 'payer.credits_expired'
        AND payload->>'payer_id' = ${w} ORDER BY created_at`;
  }

  async function remaining(lotId: string): Promise<number> {
    const [row] = await client.sql<{ credits_remaining: number }[]>`
      SELECT credits_remaining FROM credit_lots WHERE id = ${lotId}::uuid`;
    return Number(row!.credits_remaining);
  }

  async function balanceOf(w: string): Promise<number> {
    const [row] = await client.sql<{ balance: number }[]>`
      SELECT balance FROM payer_credits WHERE payer_id = ${w}::uuid`;
    return Number(row?.balance ?? 0);
  }

  async function expiredLines(w: string): Promise<{ lot_id: string; delta: number }[]> {
    return client.sql<{ lot_id: string; delta: number }[]>`
      SELECT lot_id, delta FROM credit_ledger WHERE payer_id = ${w}::uuid AND reason = 'expired'
      ORDER BY created_at, id`;
  }

  /** (h) balance = Σ open lots, and — when no raw SQL moved the balance — = Σ ledger delta. */
  async function expectInvariant(w: string, opts: { ledger: boolean }): Promise<void> {
    const [row] = await client.sql<{ balance: number; lots: number; ledger: number }[]>`
      SELECT
        coalesce((SELECT balance FROM payer_credits WHERE payer_id = ${w}::uuid), 0)::int AS balance,
        coalesce((SELECT sum(credits_remaining) FROM credit_lots WHERE payer_id = ${w}::uuid), 0)::int AS lots,
        coalesce((SELECT sum(delta) FROM credit_ledger WHERE payer_id = ${w}::uuid), 0)::int AS ledger`;
    expect(Number(row!.lots), `Σ open lots of ${w}`).toBe(Number(row!.balance));
    if (opts.ledger) expect(Number(row!.ledger), `Σ ledger of ${w}`).toBe(Number(row!.balance));
  }

  // -------------------------------------------------------------------------------------------
  // (a) spend order
  // -------------------------------------------------------------------------------------------

  it("(a) with lots expiring on day 10 and day 50, a spend debits the day-10 lot; a lot that never expires is spent last (B7-08)", async () => {
    const w = wallet();
    const day50 = await pack(w, 2);
    const day10 = await pack(w, 2);
    const never = await pack(w, 2);
    await setExpiry(day50, "50 days");
    await setExpiry(day10, "10 days");
    await setExpiry(never, null);

    const order: string[] = [];
    for (let i = 0; i < 6; i++) order.push((await spend(w))!.lotId);
    expect(order).toEqual([day10, day10, day50, day50, never, never]);
    expect(await spend(w)).toBeUndefined();

    // One `unlock_debit` line per spend, each naming the lot it came from.
    const lines = await client.sql<{ lot_id: string }[]>`
      SELECT lot_id FROM credit_ledger WHERE payer_id = ${w}::uuid AND reason = 'unlock_debit'
      ORDER BY created_at, id`;
    expect(lines.map((l) => l.lot_id)).toEqual(order);
    await expectInvariant(w, { ledger: true });
  });

  // -------------------------------------------------------------------------------------------
  // (b) expiry on the spend path
  // -------------------------------------------------------------------------------------------

  it("(b) a lot past its date is expired by the spend with exactly ONE `expired` line, and never again", async () => {
    const w = wallet();
    const past = await pack(w, 3);
    const live = await pack(w, 2);
    await setExpiry(past, "-1 day");

    const first = await spendRaw(w);
    expect(first).toMatchObject({ ok: true, balanceAfter: 1, lotId: live });
    // The lot it expired first, for UnlockService to report after the commit.
    expect(first!.expiredLots).toEqual([
      { lotId: past, credits: 3, source: "pack", expiresAt: expect.any(Date) },
    ]);
    expect(await expiredLines(w)).toEqual([{ lot_id: past, delta: -3 }]);
    const [lot] = await client.sql<{ credits_remaining: number; expired_at: Date | null }[]>`
      SELECT credits_remaining, expired_at FROM credit_lots WHERE id = ${past}::uuid`;
    expect(Number(lot!.credits_remaining)).toBe(0);
    expect(lot!.expired_at).not.toBeNull();
    const [key] = await client.sql<{ idempotency_key: string }[]>`
      SELECT idempotency_key FROM credit_ledger WHERE payer_id = ${w}::uuid AND reason = 'expired'`;
    expect(key!.idempotency_key).toBe(`credit_lot_expired:${past}`);

    // A second spend, the sweep, and a spend with nothing left add no second `expired` line.
    expect(await spend(w)).toEqual({ balanceAfter: 0, lotId: live });
    await repo.expireDueLotsForWallet(w as unknown as StoredWalletKey);
    expect(await spend(w)).toBeUndefined();
    expect(await expiredLines(w)).toHaveLength(1);
    await expectInvariant(w, { ledger: true });
  });

  it("(b) a spend that CANNOT happen (every lot past due) writes NOTHING (#2749 review, F-1/F-3)", async () => {
    const w = wallet();
    const past = await pack(w, 4);
    await setExpiry(past, "-2 days");
    expect(await balanceOf(w)).toBe(4);
    expect(await repo.getSpendableBalance(w)).toBe(0);

    const before = await snapshot(w);
    expect(await spendRaw(w)).toBeUndefined();
    // Byte for byte: no expiry line, no lot or balance change, no event.
    expect(await snapshot(w)).toBe(before);
    await expectInvariant(w, { ledger: true });
  });

  // -------------------------------------------------------------------------------------------
  // (c) the sweep
  // -------------------------------------------------------------------------------------------

  it("(c) the sweep expires due lots once and leaves the others", async () => {
    const w = wallet();
    const due = await pack(w, 4);
    const future = await pack(w, 2);
    const never = await pack(w, 1);
    await setExpiry(due, "-1 hour");
    await setExpiry(future, "30 days");

    const processor = new CreditLotExpirySweepProcessor(
      repo,
      { upsertJobScheduler: vi.fn() } as never,
      { CREDIT_LOT_EXPIRY_SWEEP_INTERVAL_MINUTES: 15, CREDIT_LOT_EXPIRY_BATCH_LIMIT: 500 } as never,
      new EventsService(new EventsRepository(client.db), { NODE_ENV: "test" } as never),
    );
    expect(await repo.findWalletsWithDueLots(500)).toContain(w);
    const tick = await processor.process();
    expect(tick.walletsFailed).toBe(0);
    expect(tick.creditsExpired).toBeGreaterThanOrEqual(4);

    expect(await remaining(due)).toBe(0);
    expect(await remaining(future)).toBe(2);
    expect(await remaining(never)).toBe(1);
    expect(await balanceOf(w)).toBe(3);
    expect(await expiredLines(w)).toEqual([{ lot_id: due, delta: -4 }]);
    // ONE validated payer.credits_expired on the spine, written after the wallet's commit.
    const fired = await expiredEvents(w);
    expect(fired.map((e) => e.payload)).toEqual([
      {
        payer_id: w,
        lot_id: due,
        credits: 4,
        source: "pack",
        expires_at: expect.stringMatching(/Z$/),
        trigger: "sweep",
      },
    ]);

    // A second tick: the wallet is no longer due, and nothing more is written.
    expect(await repo.findWalletsWithDueLots(500)).not.toContain(w);
    await processor.process();
    expect(await repo.expireDueLotsForWallet(w as unknown as StoredWalletKey)).toMatchObject({
      walletFound: true,
      creditsExpired: 0,
      lotsExpired: 0,
    });
    expect(await expiredLines(w)).toHaveLength(1);
    expect(await expiredEvents(w)).toHaveLength(1); // a second tick emits nothing
    await expectInvariant(w, { ledger: true });
  });

  // -------------------------------------------------------------------------------------------
  // (d) the Razorpay settle
  // -------------------------------------------------------------------------------------------

  it("(d) a settle creates exactly one lot per order, and a replay — even past the claim — adds nothing", async () => {
    const w = wallet();
    const providerOrderId = `order_2749_${randomUUID().slice(0, 8)}`;
    const order = await repo.createPaymentOrder({
      payerId: w,
      packCode: "pack_50",
      amountInr: 2000,
      creditsGranted: 50,
      providerOrderId,
    });
    orderIds.push(order.id);
    // The real gateway's settle; the catalog drift check is informational and fails open.
    const pricing = {
      getActiveCatalog: async () => {
        throw new Error("no catalog in this test");
      },
    };
    const gateway = new PaymentGateway(repo, {} as never, pricing as never, {} as never);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

    const first = await gateway.settleOrder({ providerOrderId, providerPaymentRef: "pay_2749_1" });
    expect(first).toMatchObject({ outcome: "granted", balanceAfter: 50, credits: 50 });
    // A webhook redelivery and the browser verify: already settled, nothing added.
    expect(
      await gateway.settleOrder({ providerOrderId, providerPaymentRef: "pay_2749_1" }),
    ).toMatchObject({ outcome: "already_settled" });

    // Layer 3: an order put back to `created` by hand is claimed again, but its key is on the
    // ledger, so the grant writes nothing and the claim reads as a lost race.
    await client.sql`UPDATE payment_orders SET status = 'created' WHERE id = ${order.id}::uuid`;
    expect(
      await repo.withTransaction((tx) =>
        repo.claimAndCreditPaymentOrderWithinTx(tx, {
          providerOrderId,
          providerPaymentRef: "pay_2749_1",
        }),
      ),
    ).toBeUndefined();

    const lots = await client.sql<
      { source: string; pack_code: string; credits_granted: number; expires_at: Date | null }[]
    >`SELECT source, pack_code, credits_granted, expires_at FROM credit_lots
      WHERE payment_order_id = ${order.id}::uuid`;
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ source: "pack", pack_code: "pack_50", expires_at: null });
    expect(Number(lots[0]!.credits_granted)).toBe(50);
    const [lines] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM credit_ledger WHERE idempotency_key = ${`payment_order:${order.id}`}`;
    expect(Number(lines!.n)).toBe(1);
    expect(await balanceOf(w)).toBe(50);
    await expectInvariant(w, { ledger: true });
  });

  // -------------------------------------------------------------------------------------------
  // (e) the grant writers
  // -------------------------------------------------------------------------------------------

  it("(e) the mock pack, the admin grant and the free-tier grant each write one lot; keyed replays add nothing", async () => {
    // Mock pack (POST /payer/credits): one `pack` lot. Its route-level replay guard is the
    // Idempotency-Key (Redis); the helper's own key is exercised here by passing one.
    const wPack = wallet();
    for (let i = 0; i < 2; i++) {
      await repo.creditPack({
        payerId: wPack,
        credits: 10,
        reason: "pack_purchase",
        packCode: "pack_10",
        paymentRef: null,
        idempotencyKey: `mock-pack:${wPack}`,
      });
    }
    const packLots = await client.sql<{ source: string; pack_code: string }[]>`
      SELECT source, pack_code FROM credit_lots WHERE payer_id = ${wPack}::uuid`;
    expect(packLots).toEqual([{ source: "pack", pack_code: "pack_10" }]);
    expect(await balanceOf(wPack)).toBe(10);
    await expectInvariant(wPack, { ledger: true });

    // Admin grant: one never-expiring `goodwill` lot; a replay of the key is applied:false.
    const wAdmin = wallet();
    const admin = new AdminActionsRepository(client.db);
    const key = randomUUID();
    const g1 = await admin.grantCredits(wAdmin, 7, key);
    const g2 = await admin.grantCredits(wAdmin, 7, key);
    expect(g1).toMatchObject({ applied: true, balance: 7 });
    expect(g2).toEqual({ applied: false, balance: 7, ledgerId: g1.ledgerId });
    const adminLots = await client.sql<{ source: string; expires_at: Date | null }[]>`
      SELECT source, expires_at FROM credit_lots WHERE payer_id = ${wAdmin}::uuid`;
    expect(adminLots).toEqual([{ source: "goodwill", expires_at: null }]);
    await expectInvariant(wAdmin, { ledger: true });

    // Free tier (signup): one never-expiring `legacy` lot; the second call grants 0.
    const wFree = wallet();
    const freeTier = new FreeTierService(client.db, {
      get: async () => ({ freeUnlockCredits: 50 }),
    } as never);
    expect(await freeTier.grantForPayer(wFree)).toBe(50);
    expect(await freeTier.grantForPayer(wFree)).toBe(0);
    const freeLots = await client.sql<{ source: string; credits_granted: number }[]>`
      SELECT source, credits_granted FROM credit_lots WHERE payer_id = ${wFree}::uuid`;
    expect(freeLots.map((l) => [l.source, Number(l.credits_granted)])).toEqual([["legacy", 50]]);
    await expectInvariant(wFree, { ledger: true });

    // Every grant line names its lot.
    const [orphans] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM credit_ledger
      WHERE payer_id = ANY(${[wPack, wAdmin, wFree]}::uuid[]) AND lot_id IS NULL`;
    expect(Number(orphans!.n)).toBe(0);
  });

  // -------------------------------------------------------------------------------------------
  // (f) alignment
  // -------------------------------------------------------------------------------------------

  it("(f) a balance moved WITHOUT lots (old code, a seed, a repair) is re-aligned at the next touch, with one ERROR line", async () => {
    // ERROR level, stable prefix: after the apply-to-deploy window this must never fire.
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const realignWarnings = () =>
      error.mock.calls.filter((c) =>
        String(c[0]).startsWith("credit-wallet: lots out of step with balance"),
      );

    // UP: +3 credits by raw SQL → the next spend tops up a never-expiring legacy lot.
    const w = wallet();
    const packLot = await pack(w, 5);
    await client.sql`UPDATE payer_credits SET balance = balance + 3 WHERE payer_id = ${w}::uuid`;
    const debit = await spend(w);
    expect(debit).toEqual({ balanceAfter: 7, lotId: packLot }); // the older never-expiring lot
    const legacy = await client.sql<{ source: string; credits_remaining: number }[]>`
      SELECT source, credits_remaining FROM credit_lots
      WHERE payer_id = ${w}::uuid AND source = 'legacy'`;
    expect(legacy.map((l) => Number(l.credits_remaining))).toEqual([3]);
    expect(realignWarnings()).toHaveLength(1);
    expect(String(realignWarnings()[0]![0])).toContain(`wallet=${w} action=top_up credits=3`);
    await expectInvariant(w, { ledger: false });

    // A second touch finds nothing to align and logs nothing.
    await spend(w);
    expect(realignWarnings()).toHaveLength(1);

    // DOWN: −4 by raw SQL → the excess leaves the soonest-expiring lot first.
    const v = wallet();
    const later = await pack(v, 3);
    const sooner = await pack(v, 2);
    const forever = await pack(v, 5);
    await setExpiry(later, "40 days");
    await setExpiry(sooner, "5 days");
    await setExpiry(forever, null);
    await client.sql`UPDATE payer_credits SET balance = balance - 4 WHERE payer_id = ${v}::uuid`;
    await repo.expireDueLotsForWallet(v as unknown as StoredWalletKey); // the sweep's touch
    expect(await remaining(sooner)).toBe(0);
    expect(await remaining(later)).toBe(1);
    expect(await remaining(forever)).toBe(5);
    expect(realignWarnings()).toHaveLength(2);
    expect(String(realignWarnings()[1]![0])).toContain(`wallet=${v} action=trim credits=4`);
    // No ledger line was written by either alignment (balance is the source of truth).
    const [lines] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM credit_ledger WHERE payer_id = ${v}::uuid AND reason <> 'pack_purchase'`;
    expect(Number(lines!.n)).toBe(0);
    await expectInvariant(v, { ledger: false });
  });

  // -------------------------------------------------------------------------------------------
  // (g) concurrency
  // -------------------------------------------------------------------------------------------

  it("(g) ten concurrent spends against three credits never overdraw the balance or any lot", async () => {
    const w = wallet();
    const soon = await pack(w, 2);
    const never = await pack(w, 1);
    await setExpiry(soon, "10 days");

    const results = await Promise.all(Array.from({ length: 10 }, () => spend(w)));
    const ok = results.filter((r) => r !== undefined);
    expect(ok).toHaveLength(3);
    expect(ok.map((r) => r!.balanceAfter).sort()).toEqual([0, 1, 2]);
    expect(ok.filter((r) => r!.lotId === soon)).toHaveLength(2);
    expect(ok.filter((r) => r!.lotId === never)).toHaveLength(1);
    expect(await balanceOf(w)).toBe(0);
    expect(await remaining(soon)).toBe(0);
    expect(await remaining(never)).toBe(0);
    await expectInvariant(w, { ledger: true });
  });

  it("(g) a sweep and spends racing on one wallet serialise on the wallet row (no deadlock, no double expiry)", async () => {
    const w = wallet();
    const due = await pack(w, 3);
    await pack(w, 3);
    await setExpiry(due, "-1 minute");

    const [a, b, c, sweep] = await Promise.all([
      spend(w),
      spend(w),
      spend(w),
      repo.expireDueLotsForWallet(w as unknown as StoredWalletKey),
    ]);
    expect([a, b, c].filter((r) => r !== undefined)).toHaveLength(3);
    expect(sweep.walletFound).toBe(true);
    expect(await expiredLines(w)).toEqual([{ lot_id: due, delta: -3 }]);
    expect(await balanceOf(w)).toBe(0);
    await expectInvariant(w, { ledger: true });
  });

  // -------------------------------------------------------------------------------------------
  // (i) tenancy
  // -------------------------------------------------------------------------------------------

  it("(i) two companies never share a lot: one's spends and expiry leave the other's lots whole", async () => {
    const one = wallet();
    const two = wallet();
    const lotOne = await pack(one, 2);
    const lotTwo = await pack(two, 2);
    await setExpiry(lotOne, "-1 day");

    expect(await spend(one)).toBeUndefined(); // its only lot is past due: nothing spent or written
    expect(await remaining(lotTwo)).toBe(2);
    expect(await expiredLines(two)).toEqual([]);
    expect((await spend(two))!.lotId).toBe(lotTwo);

    // Every ledger line in this file names a lot of its OWN wallet.
    const [crossed] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM credit_ledger cl JOIN credit_lots l ON l.id = cl.lot_id
      WHERE cl.payer_id = ANY(${wallets}::uuid[]) AND cl.payer_id <> l.payer_id`;
    expect(Number(crossed!.n)).toBe(0);
    await expectInvariant(one, { ledger: true });
    await expectInvariant(two, { ledger: true });
  });

  it("GET /payer/credits' lots: the open ones, in spend order, with ISO dates and no ids", async () => {
    const w = wallet();
    const never = await pack(w, 4, "pack_a");
    const soon = await pack(w, 1, "pack_b");
    const empty = await pack(w, 1, "pack_c");
    await setExpiry(soon, "3 days");
    await setExpiry(empty, "1 day");
    await spend(w); // empties the soonest lot (`empty`)

    const lots = await repo.listOpenLots(w);
    expect(lots.map((l) => [l.pack_code, l.credits_remaining, l.credits_granted])).toEqual([
      ["pack_b", 1, 1],
      ["pack_a", 4, 4],
    ]);
    expect(lots[0]!.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(lots[1]!.expires_at).toBeNull();
    expect(Object.keys(lots[0]!).sort()).toEqual(
      ["credits_granted", "credits_remaining", "expires_at", "pack_code", "source"].sort(),
    );
    expect(never).not.toBe(soon);
    await expectInvariant(w, { ledger: true });
  });

  // -------------------------------------------------------------------------------------------
  // #2749 review — the F-1/F-3 oracle, the spend path's event, the backfill, the races
  // -------------------------------------------------------------------------------------------

  it("F-1/F-3: a balance held only in lots past due is refused with NOTHING written — worker or no worker", async () => {
    const { svc, pii } = unlockService();
    const w = wallet();
    const past = await pack(w, 3);
    await setExpiry(past, "-1 day");
    const realWorker = await consentingWorker(pii);
    const before = await snapshot(w);

    const withWorker = await svc.requestUnlock(
      { payerId: w, workerId: realWorker, jobId: null },
      CTX,
    );
    const afterWorker = await snapshot(w);
    const noWorker = await svc.requestUnlock(
      { payerId: w, workerId: randomUUID(), jobId: null },
      CTX,
    );

    expect(withWorker).toEqual({ status: "unavailable" });
    expect(JSON.stringify(noWorker)).toBe(JSON.stringify(withWorker));
    // Ledger, lots, balance and the credits_expired count are byte-for-byte unchanged, both ways.
    expect(afterWorker).toBe(before);
    expect(await snapshot(w)).toBe(before);
    const [unlocks] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM unlocks WHERE payer_id = ${w}::uuid`;
    expect(Number(unlocks!.n)).toBe(0);
    // The two requests left the same events on the spine: the request audit and payment.failed,
    // once each — and no credits_expired.
    const names = await client.sql<{ event_name: string }[]>`
      SELECT event_name FROM events
      WHERE correlation_id = ${CTX.correlationId}::uuid AND actor_id = ${w}::uuid
      ORDER BY event_name`;
    expect(names.map((e) => e.event_name)).toEqual([
      "payment.failed",
      "payment.failed",
      "unlock.requested",
      "unlock.requested",
    ]);
  });

  it("a contact open that spends expires the due lot first, with ONE payer.credits_expired on the unlock transaction", async () => {
    const { svc, pii } = unlockService();
    const w = wallet();
    const due = await pack(w, 2);
    const live = await pack(w, 3);
    await setExpiry(due, "-1 hour");
    const worker = await consentingWorker(pii);
    // Spendable = 5 − the 2 past due — THIS wallet's due lots only (the F-1 test's wallet above
    // still holds a due lot in this database; a correlated read that leaked across wallets
    // would answer 0 here).
    expect(await repo.getSpendableBalance(w)).toBe(3);

    const out = await svc.requestUnlock({ payerId: w, workerId: worker, jobId: null }, CTX);
    expect(out).toMatchObject({ ok: true, status: "granted" });
    expect(await remaining(due)).toBe(0);
    expect(await remaining(live)).toBe(2);
    expect(await expiredLines(w)).toEqual([{ lot_id: due, delta: -2 }]);
    const fired = await expiredEvents(w);
    expect(fired.map((e) => e.payload)).toEqual([
      {
        payer_id: w,
        lot_id: due,
        credits: 2,
        source: "pack",
        expires_at: expect.stringMatching(/Z$/),
        trigger: "spend",
      },
    ]);
    await expectInvariant(w, { ledger: true });
  });

  it("the 0170 backfill statement: one legacy lot per positive balance, and a second run adds nothing", async () => {
    const raw = readFileSync(
      join(__dirname, "../../../../packages/db/migrations/0170_credit_lots.sql"),
      "utf8",
    );
    const backfill = raw
      .replace(/--[^\n]*/g, " ")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(`INSERT INTO "credit_lots"`));
    expect(backfill).toBeDefined();
    const [zero, one, fifty] = [wallet(), wallet(), wallet()];
    const ROLLBACK = new Error("roll the backfill probe back");
    // In ONE transaction rolled back at the end: the backfill is global, so it must not touch the
    // rest of this shared database.
    const probe = client.sql.begin(async (sql) => {
      await sql`
        INSERT INTO payer_credits (payer_id, balance)
        VALUES (${zero}::uuid, 0), (${one}::uuid, 1), (${fifty}::uuid, 50)`;
      await sql.unsafe(backfill!);
      const first = await sql<
        { payer_id: string; source: string; g: number; r: number; e: Date | null }[]
      >`
        SELECT payer_id, source, credits_granted AS g, credits_remaining AS r, expires_at AS e
        FROM credit_lots WHERE payer_id = ANY(${[zero, one, fifty]}::uuid[]) ORDER BY credits_granted`;
      expect(first.map((l) => [l.payer_id, l.source, Number(l.g), Number(l.r), l.e])).toEqual([
        [one, "legacy", 1, 1, null],
        [fifty, "legacy", 50, 50, null],
      ]);
      await sql.unsafe(backfill!);
      const [again] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM credit_lots WHERE payer_id = ANY(${[zero, one, fifty]}::uuid[])`;
      expect(Number(again!.n)).toBe(2);
      throw ROLLBACK;
    });
    await expect(probe).rejects.toBe(ROLLBACK);
    const [left] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payer_credits WHERE payer_id = ANY(${[zero, one, fifty]}::uuid[])`;
    expect(Number(left!.n)).toBe(0);
  });

  it("two concurrent FIRST grants on a brand-new wallet (distinct keys) both land: one wallet row, two lots", async () => {
    const w = wallet();
    const admin = new AdminActionsRepository(client.db);
    const [a, b] = await Promise.all([
      admin.grantCredits(w, 5, randomUUID()),
      admin.grantCredits(w, 7, randomUUID()),
    ]);
    expect(a.applied && b.applied).toBe(true);
    // They serialised on the wallet row: the second saw the first's balance.
    expect(Math.max(a.balance, b.balance)).toBe(12);
    expect([5, 7]).toContain(Math.min(a.balance, b.balance));
    expect(await balanceOf(w)).toBe(12);
    const [rows] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payer_credits WHERE payer_id = ${w}::uuid`;
    expect(Number(rows!.n)).toBe(1);
    const lots = await client.sql<{ credits_granted: number }[]>`
      SELECT credits_granted FROM credit_lots WHERE payer_id = ${w}::uuid ORDER BY credits_granted`;
    expect(lots.map((l) => Number(l.credits_granted))).toEqual([5, 7]);
    await expectInvariant(w, { ledger: true });
  });

  it("two settleOrder calls racing on ONE order: one lot, one ledger line, one grant", async () => {
    const w = wallet();
    const providerOrderId = `order_2749r_${randomUUID().slice(0, 8)}`;
    const order = await repo.createPaymentOrder({
      payerId: w,
      packCode: "pack_50",
      amountInr: 2000,
      creditsGranted: 50,
      providerOrderId,
    });
    orderIds.push(order.id);
    const pricing = {
      getActiveCatalog: async () => {
        throw new Error("no catalog in this test");
      },
    };
    const gateway = new PaymentGateway(repo, {} as never, pricing as never, {} as never);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

    const results = await Promise.all([
      gateway.settleOrder({ providerOrderId, providerPaymentRef: "pay_2749r_1" }),
      gateway.settleOrder({ providerOrderId, providerPaymentRef: "pay_2749r_1" }),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["already_settled", "granted"]);
    const [lots] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM credit_lots WHERE payment_order_id = ${order.id}::uuid`;
    expect(Number(lots!.n)).toBe(1);
    const [lines] = await client.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM credit_ledger WHERE idempotency_key = ${`payment_order:${order.id}`}`;
    expect(Number(lines!.n)).toBe(1);
    expect(await balanceOf(w)).toBe(50);
    await expectInvariant(w, { ledger: true });
  });

  it("the sweep's work list holds only wallets with a payer_credits row; orphans are counted (no starvation)", async () => {
    const w = wallet();
    const lotId = await pack(w, 2);
    await setExpiry(lotId, "-1 hour");
    expect(await repo.findWalletsWithDueLots(10_000)).toContain(w);
    const orphansBefore = await repo.countOrphanWalletsWithDueLots();
    // The wallet row disappears (a hand-deleted row): its due lot can never be expired.
    await client.sql`DELETE FROM payer_credits WHERE payer_id = ${w}::uuid`;
    expect(await repo.findWalletsWithDueLots(10_000)).not.toContain(w);
    expect(await repo.countOrphanWalletsWithDueLots()).toBe(orphansBefore + 1);
    // Close the orphan by hand so the shared database is left clean for the counts above.
    await client.sql`
      UPDATE credit_lots SET credits_remaining = 0, updated_at = now() WHERE payer_id = ${w}::uuid`;
    expect(await repo.countOrphanWalletsWithDueLots()).toBe(orphansBefore);
  });

  it("mixed writers racing on one wallet (spends, a pack, an admin grant, the sweep) finish with no deadlock and the invariants hold", async () => {
    const w = wallet();
    const due = await pack(w, 3);
    await pack(w, 4);
    await setExpiry(due, "-1 minute");
    const admin = new AdminActionsRepository(client.db);

    const settled = await Promise.allSettled([
      spend(w),
      spend(w),
      repo.creditPack({
        payerId: w,
        credits: 2,
        reason: "pack_purchase",
        packCode: "pack_test",
        paymentRef: null,
      }),
      admin.grantCredits(w, 1, randomUUID()),
      repo.expireDueLotsForWallet(w as unknown as StoredWalletKey),
      spend(w),
    ]);
    // No 40P01 (deadlock) or any other failure: every writer took the wallet row first.
    expect(settled.filter((r) => r.status === "rejected")).toEqual([]);
    expect(await expiredLines(w)).toEqual([{ lot_id: due, delta: -3 }]);
    // 3 + 4 + 2 + 1 granted, 3 expired, 3 spent.
    expect(await balanceOf(w)).toBe(4);
    await expectInvariant(w, { ledger: true });
  });
});
