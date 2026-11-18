import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import {
  type Database,
  type Unlock,
  type UnlockRouting,
  type CreditReason,
  type UnlockStatus,
  type UnlockDenyReason,
  type RoutingChannel,
  type PaymentOrder,
  type PaymentOrderStatus,
  type ExpiredCreditLot,
  type LotAlignment,
  type WalletExpiryResult,
  type WalletGrantResult,
  CREDIT_LOT_SPEND_ORDER,
  countOrphanWalletsWithDueLots,
  expireWalletWithinTx,
  findWalletsWithDueLots,
  grantCreditsWithinTx,
  returnExpiredPackCreditsWithinTx,
  type PackReturnResult,
  lotAlignmentWarning,
  readSpendableCredits,
  spendOneCreditWithinTx,
  spendCreditsWithinTx,
  type WalletSpendTake,
  unlocks,
  unlockRouting,
  payerCredits,
  creditLedger,
  creditLots,
  paymentOrders,
  workers,
  jobs,
  jobPostings,
  workerProfiles,
  workerProfileSkills,
  workerSkills,
  workerInstituteLinks,
  RVM_INSTITUTE_CODE,
} from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import { findOwnedJobRef, type OwnedJobRef } from "../payers/owned-job-ref";
import type { TenantKey } from "../payers/payer-tenant-scope";
import { OPS_LIST_CAP } from "../common/pagination";
import type { CreditLotSource, PaymentOrderOrigin } from "@badabhai/types";

/**
 * The one payment provider this stream supports, and the value that must match
 * `payment_orders.provider`'s DB default.
 *
 * It lives HERE, with the only writer of that table, so the string that goes into the
 * uniqueness key `(provider, provider_order_id)` is defined once. A second provider is an
 * additive value, never a rename — renaming it would silently split the idempotency key's
 * namespace and let an already-settled order settle a second time under the new name.
 */
export const RAZORPAY_PROVIDER = "razorpay";

/**
 * A Drizzle transaction handle. The chokepoint ({@link UnlockService}) opens ONE
 * transaction per grant/reveal and threads `tx` through these methods, so the
 * cap-check + credit-debit + grant/reveal-write are ONE atomic operation
 * (Phase-0 F-2 / F-6). `Tx` is the first argument of a `db.transaction` callback.
 */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** PII-free projection of a credit_ledger movement (amounts + opaque ids only). */
export interface CreditLedgerItem {
  id: string;
  delta: number;
  reason: CreditReason;
  unlock_id: string | null;
  pack_code: string | null;
  payment_ref: string | null;
  /**
   * The ₹ amount STAMPED at purchase (D-6). Null for movements with no amount (debits /
   * ops grants) and for rows written before the column existed — the UI renders an honest
   * placeholder for null and NEVER back-fills from the current catalog (that is exactly
   * the retroactive re-pricing this column removes).
   */
  price_inr: number | null;
  created_at: Date;
}

/** One credit movement into a wallet — everything but WHICH wallet (the caller's authority). */
export interface WalletCredit {
  credits: number;
  reason: CreditReason;
  packCode: string | null;
  paymentRef: string | null;
  /**
   * The amount CHARGED, whole ₹ (D-6). Stamped onto the row so History renders what this
   * purchase ACTUALLY cost, immune to any later ops price edit. Null for ops grants /
   * movements with no amount. Since #2749 PR 3 a pack's charge is its GST-inclusive TOTAL.
   */
  priceInr?: number | null;
  /**
   * EXACTLY-ONCE key for the ledger insert (`credit_ledger_idempotency_key_uq`, a full unique
   * index on the nullable key). Optional: movements with no natural dedup key leave it null and
   * never collide (NULLS DISTINCT). The real-payment path passes a key derived from the order row.
   */
  idempotencyKey?: string | null;
  /**
   * #2749 PR 3 — how long the pack lot's credits last, in days: the lot expires that many days
   * after the grant, on the database clock (`now()` of the granting transaction). Null or absent =
   * never expires.
   */
  validityDays?: number | null;
}

/**
 * The money a payment order is stamped with at creation (#2749, migration 0176): the pack's GST
 * price line, in integer paise (`gstPriceLine`). taxable + gst + roundOff = total, a whole rupee.
 */
export interface PaymentOrderMoney {
  taxablePaise: number;
  gstPaise: number;
  roundOffPaise: number;
  totalPaise: number;
  gstRateBps: number;
}

/**
 * What a held capture recorded (#2749 hardening 5): the provider's payment id, stamped on the row so
 * ops can find the payment in the Razorpay dashboard to refund it. Opaque.
 */
export interface HoldPaymentOrderInput {
  providerOrderId: string;
  providerPaymentRef: string;
  provider?: string;
}

/**
 * The statuses a capture may move an order out of — to `paid` (the settle claim) or to `held`.
 * `failed` is included on purpose: Razorpay lets a buyer retry a failed payment on the SAME order,
 * and that later capture must still settle it. `paid` and `held` are terminal for a capture.
 */
const CAPTURABLE_ORDER_STATUSES = [
  "created",
  "failed",
] as const satisfies readonly PaymentOrderStatus[];

/**
 * One OPEN lot of the tenant's wallet as `GET /payer/credits` returns it (#2749): what is left,
 * what it granted, when it ends, and the pack it came from. No lot id, no payment reference.
 */
export interface OpenLotProjection {
  source: CreditLotSource;
  credits_remaining: number;
  credits_granted: number;
  /** ISO 8601, or null when the lot never expires. */
  expires_at: string | null;
  pack_code: string | null;
}

/**
 * What {@link UnlocksRepository.tryDebit} answers when it spent a credit (#2749): the new balance,
 * the lot, and the lots it expired first (absent = none). `undefined` keeps its pre-#2749 meaning,
 * no credit to spend, and since the #2749 review it also means NOTHING was written. `ok` is
 * optional so callers' fakes that return `{ balanceAfter, lotId }` keep their meaning.
 */
/**
 * #2750 item 2 — one worker's price facts, as {@link UnlocksRepository.readContactCostFacts} reads
 * them. The cost rule (`contact-cost-facts.ts`) turns these into `ContactCostFacts`.
 */
export interface ContactCostFactsRow {
  /** His latest stated rung per trade, with his bucketed months in that trade (null = no row). */
  rungs: { skillId: string; tradeLevel: string; months: number | null }[];
  /** `experience.total_years` on his latest profile, or null. */
  totalYears: number | null;
  /** An ACTIVE RVM institute link. */
  rvmStudent: boolean;
  /** This company's unlock row for him (one per company and worker), or null. */
  grant: { status: UnlockStatus; expiresAt: Date | null } | null;
}

/** `experience` JSONB → `total_years`, or null for anything missing or unparseable. */
function totalYearsOf(experience: unknown): number | null {
  if (typeof experience !== "object" || experience === null || Array.isArray(experience)) {
    return null;
  }
  const years = (experience as Record<string, unknown>).total_years;
  return typeof years === "number" && Number.isFinite(years) && years >= 0 ? years : null;
}

/** #2750 item 2 — what {@link UnlocksRepository.tryDebitCredits} spent: one take per lot. */
export interface TryDebitCreditsResult {
  balanceAfter: number;
  takes: readonly WalletSpendTake[];
  expiredLots: readonly ExpiredCreditLot[];
}

export interface TryDebitResult {
  ok?: true;
  balanceAfter: number;
  lotId: string;
  /** The lots this spend expired before it spent (absent = none). */
  expiredLots?: readonly ExpiredCreditLot[];
}

/**
 * A wallet key READ FROM `credit_lots` by {@link UnlocksRepository.findWalletsWithDueLots} — the
 * expiry sweep's only input. Branded so the sweep can only expire a wallet the table itself named
 * (the same rule as settlement, which credits only the wallet the claimed order row names): no
 * request, body or caller supplies it, so it is not a tenant resolution and needs none.
 */
export type StoredWalletKey = string & { readonly __storedWalletKey: unique symbol };

/** PII-free ops/list projection of an unlock row (NO routing token resolved). */
export interface UnlockProjection {
  unlock_id: string;
  payer_id: string;
  // NULLABLE post-ADR-0026 Phase 5: a worker hard-delete (DSAR) SET-NULLs the identity join
  // while preserving this PII-free paid-grant row (migration 0030). The reveal path guards on
  // a null worker_id BEFORE relaying (a gone worker cannot be revealed).
  worker_id: string | null;
  job_id: string | null;
  /**
   * #2033 (migration 0132) — the COMPANY-posting context, the `job_postings` twin of `job_id`.
   * Null for search, an agency `jobs` context (that is `job_id`), the ops route, and every row
   * written before 0132. Additive: older clients ignore it.
   */
  job_posting_id: string | null;
  status: UnlockStatus;
  reveal_count: number;
  granted_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
}

/**
 * Drizzle data access for Contact Unlock + Reveal (ADR-0010, Stream A). PURE data
 * access — no business logic, no event emission (those live in {@link UnlockService}).
 *
 * STRUCTURAL chokepoint (Phase-0 F-2/F-5/T5-b): the WRITE methods for `unlocks` and
 * `unlock_routing`, and the routing-token resolver, are tx-scoped and are only ever
 * called from {@link UnlockService}. No other module imports this repository. The
 * raw phone is NEVER read or written here — it is touched only transiently in the
 * service's reveal handler.
 *
 * TENANCY (ADR-0053, PAY-DB-01). Every predicate and stamp on a tenant row — `unlocks`,
 * `payer_credits` (the org wallet), `credit_ledger`, `payment_orders` — takes a {@link TenantKey},
 * never a raw payer id. The key comes only from `PayerTenantScopeService`: the service resolves
 * it once per request and passes it down. In mode `off` the key IS the session payer, so every
 * statement here is byte-identical to before; in `on` it is the acting org's anchor. The column
 * keeps its name (`payer_id`) and now means "the tenant" (ADR-0053 §3.1).
 */
@Injectable()
export class UnlocksRepository {
  /**
   * #2749 — the one log line this repository writes, at ERROR: a wallet whose lots the
   * credit-wallet helper just re-aligned with its balance (ids and numbers only). It reports the
   * state of the write it made, so it lives beside the write; after the 0174 apply-to-deploy
   * window it should never fire, and any occurrence means a writer bypassed the helpers.
   */
  private readonly walletLog = new Logger("CreditWallet");

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Run `work` inside a single DB transaction (the chokepoint's atomic boundary). */
  async withTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  /**
   * The worker's stated trade rungs (Middle Way P5 price-tier hook input).
   *
   * Tx-SCOPED like the deletion-marker read above: the grant path calls it inside
   * the locked transaction, so the tier it prices is the rung the worker holds at
   * grant time. Ids + closed-set rung keys only — no PII, and the caller logs
   * nothing but the tier. Latest profile wins per skill: a re-interview rewrites
   * the rung, and the newest statement is the current truth.
   */
  async findTradeLevels(
    tx: Tx,
    workerId: string,
  ): Promise<{ skillId: string; tradeLevel: string }[]> {
    const rows = await tx
      .selectDistinctOn([workerProfileSkills.skillId], {
        skillId: workerProfileSkills.skillId,
        tradeLevel: workerProfileSkills.tradeLevel,
      })
      .from(workerProfiles)
      .innerJoin(workerProfileSkills, eq(workerProfileSkills.workerProfileId, workerProfiles.id))
      .where(and(eq(workerProfiles.workerId, workerId), isNotNull(workerProfileSkills.tradeLevel)))
      .orderBy(workerProfileSkills.skillId, desc(workerProfiles.createdAt));
    return rows.flatMap((r) =>
      r.tradeLevel === null ? [] : [{ skillId: r.skillId, tradeLevel: r.tradeLevel }],
    );
  }

  /**
   * #2750 item 2 — the facts the cost of opening each worker is priced from, for a page of
   * workers at once (the quote) or one (the open). FACTS ALREADY ON THE CARD ONLY: his stated
   * rungs, his experience, whether he is an actively linked RVM student, and whether THIS company
   * already holds a contact for him. Nothing here reads consent, a limit or deletion state, so the
   * price can never be a probe of those (#2750 private notes item 5). A worker id with no rows gets
   * empty facts (the standard cost), exactly like a worker who stated nothing: the price says
   * nothing about whether an id exists.
   *
   * Global-pool reads (never inside the advisory-locked transaction: the deadlock rule in
   * UnlockService). Ids, closed rung keys and integers only.
   */
  async readContactCostFacts(
    tenant: TenantKey,
    workerIds: readonly string[],
  ): Promise<Map<string, ContactCostFactsRow>> {
    const out = new Map<string, ContactCostFactsRow>();
    for (const id of workerIds) {
      out.set(id, { rungs: [], totalYears: null, rvmStudent: false, grant: null });
    }
    const ids = [...out.keys()];
    if (ids.length === 0) return out;

    // Latest stated rung per (worker, trade), with his bucketed months in that trade.
    const rungs = await this.db
      .selectDistinctOn([workerProfiles.workerId, workerProfileSkills.skillId], {
        workerId: workerProfiles.workerId,
        skillId: workerProfileSkills.skillId,
        tradeLevel: workerProfileSkills.tradeLevel,
      })
      .from(workerProfiles)
      .innerJoin(workerProfileSkills, eq(workerProfileSkills.workerProfileId, workerProfiles.id))
      .where(and(inArray(workerProfiles.workerId, ids), isNotNull(workerProfileSkills.tradeLevel)))
      .orderBy(
        workerProfiles.workerId,
        workerProfileSkills.skillId,
        desc(workerProfiles.createdAt),
      );
    const months = await this.db
      .select({
        workerId: workerSkills.workerId,
        skillId: workerSkills.skillId,
        months: workerSkills.monthsBucketed,
      })
      .from(workerSkills)
      .where(inArray(workerSkills.workerId, ids));
    const monthsOf = new Map(months.map((m) => [`${m.workerId}|${m.skillId}`, m.months]));
    for (const r of rungs) {
      if (r.tradeLevel === null) continue;
      out.get(r.workerId)?.rungs.push({
        skillId: r.skillId,
        tradeLevel: r.tradeLevel,
        months: monthsOf.get(`${r.workerId}|${r.skillId}`) ?? null,
      });
    }

    // His total experience from the latest profile (the card's "x yrs" band comes from it).
    const profiles = await this.db
      .selectDistinctOn([workerProfiles.workerId], {
        workerId: workerProfiles.workerId,
        experience: workerProfiles.experience,
      })
      .from(workerProfiles)
      .where(inArray(workerProfiles.workerId, ids))
      .orderBy(workerProfiles.workerId, desc(workerProfiles.createdAt));
    for (const p of profiles) {
      const row = out.get(p.workerId);
      if (row) row.totalYears = totalYearsOf(p.experience);
    }

    // The card's "RVM student" label (#2747 item 1): an ACTIVE RVM link.
    const links = await this.db
      .select({ workerId: workerInstituteLinks.workerId })
      .from(workerInstituteLinks)
      .where(
        and(
          inArray(workerInstituteLinks.workerId, ids),
          eq(workerInstituteLinks.status, "active"),
          eq(workerInstituteLinks.instituteCode, RVM_INSTITUTE_CODE),
        ),
      );
    for (const l of links) {
      const row = out.get(l.workerId);
      if (row) row.rvmStudent = true;
    }

    // What this company already holds for him (the card shows an opened contact as opened).
    const grants = await this.db
      .select({
        workerId: unlocks.workerId,
        status: unlocks.status,
        expiresAt: unlocks.expiresAt,
      })
      .from(unlocks)
      .where(and(eq(unlocks.payerId, tenant), inArray(unlocks.workerId, ids)));
    for (const g of grants) {
      if (g.workerId === null) continue;
      const row = out.get(g.workerId);
      if (row) row.grant = { status: g.status, expiresAt: g.expiresAt };
    }
    return out;
  }

  /**
   * Take a transaction-scoped advisory lock keyed on `worker_id` (Phase-0 F-2). All
   * grants + reveals for one worker serialize on this lock, so N concurrent requests
   * can NEVER each read "under cap" and all write — the cap check + write that follow
   * inside the same `tx` are effectively atomic per worker. The lock is released when
   * the transaction commits/rolls back. We hash the UUID to a bigint key space.
   */
  async lockWorker(tx: Tx, workerId: string): Promise<void> {
    // hashtextextended is stable; cast to bigint for pg_advisory_xact_lock(bigint).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workerId}, 0))`);
  }

  /**
   * The worker's ADR-0031 deletion-grace marker (`deletion_scheduled_at`), tx-SCOPED —
   * ONE cheap pk read on `workers`, on the SAME connection as the caller's locked
   * transaction (a global-pool read inside the advisory-locked tx would recreate the
   * pool-vs-lock deadlock — see the {@link UnlockService} class doc). Selects ONLY the
   * timestamp marker, never a PII column. Returns `undefined` when the worker row is
   * gone (the SET-NULL guards own that case).
   */
  async getWorkerDeletionMarker(
    tx: Tx,
    workerId: string,
  ): Promise<{ deletionScheduledAt: Date | null; status: string } | undefined> {
    const rows = await tx
      .select({
        deletionScheduledAt: workers.deletionScheduledAt,
        status: workers.status,
      })
      .from(workers)
      .where(eq(workers.id, workerId))
      .limit(1);
    return rows[0];
  }

  /**
   * Whether `jobId` names a row in the legacy `jobs` table — a NON-tx read on the global
   * pool, by primary key, projecting the id ONLY.
   *
   * #1903 (#1823 decision O9): `unlocks.job_id` is an FK to `jobs.id`, so only a `jobs` id can be
   * stored as an unlock's job context. The service calls this BEFORE the advisory-locked
   * transaction (a global-pool read inside it would recreate the pool-vs-lock deadlock —
   * see the {@link UnlockService} class doc). No status filter: the FK needs the row to
   * exist, not to be open.
   */
  async legacyJobExists(jobId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * ADR-0050 §4.5 — when `jobPostingId` is a system-owned agency TWIN, the `jobs` id it mirrors;
   * otherwise null. A NON-tx global-pool read like {@link legacyJobExists}, called BEFORE the
   * advisory-locked transaction (the same deadlock rule). A read error propagates (fail closed).
   */
  async findAgencyTwinSourceJobId(jobPostingId: string): Promise<string | null> {
    const rows = await this.db
      .select({ sourceJobId: jobPostings.sourceJobId })
      .from(jobPostings)
      .where(and(eq(jobPostings.id, jobPostingId), isNotNull(jobPostings.syncSource)))
      .limit(1);
    return rows[0]?.sourceJobId ?? null;
  }

  /**
   * #1899 — `jobId` as a `jobs` or `job_postings` row the TENANT owns, or null (unknown and
   * foreign alike). A NON-tx global-pool read like {@link legacyJobExists}, so the service
   * calls it BEFORE the advisory-locked transaction (same deadlock rule).
   */
  async findOwnedJobRef(jobId: string, tenant: TenantKey): Promise<OwnedJobRef | null> {
    return findOwnedJobRef(this.db, jobId, tenant);
  }

  /** The existing unlock for (tenant, worker), or undefined. Tx-scoped read. */
  async findByPayerWorker(
    tx: Tx,
    tenant: TenantKey,
    workerId: string,
  ): Promise<Unlock | undefined> {
    const rows = await tx
      .select()
      .from(unlocks)
      .where(and(eq(unlocks.payerId, tenant), eq(unlocks.workerId, workerId)))
      .limit(1);
    return rows[0];
  }

  /** A single unlock by id (tx-scoped, locked for the reveal flow). */
  async findByIdForUpdate(tx: Tx, unlockId: string): Promise<Unlock | undefined> {
    const rows = await tx
      .select()
      .from(unlocks)
      .where(eq(unlocks.id, unlockId))
      .limit(1)
      .for("update");
    return rows[0];
  }

  /**
   * Count distinct GRANTED/REVEALED reveals for a worker since `since` (cap window).
   * "Reveals" = unlocks for this worker whose reveal_count > 0 since `since`, summed.
   * Used for the daily-reveals cap. Tx-scoped so it sees this txn's writes.
   */
  async countRevealsSince(tx: Tx, workerId: string, since: Date): Promise<number> {
    const rows = await tx
      .select({ total: sql<number>`coalesce(sum(${unlocks.revealCount}), 0)::int` })
      .from(unlocks)
      .where(and(eq(unlocks.workerId, workerId), gte(unlocks.grantedAt, since)));
    return rows[0]?.total ?? 0;
  }

  /**
   * Count DISTINCT payers who hold a grant for a worker since `since` (weekly cap). `payer_id`
   * holds the tenant key (ADR-0053), so in mode `on` this counts distinct ORGS — owner ruling
   * O-3: the cap protects the worker from distinct companies, and a team counts once. The SQL
   * is unchanged; only what the column means changed.
   */
  async countDistinctPayersSince(tx: Tx, workerId: string, since: Date): Promise<number> {
    const rows = await tx
      .select({ count: sql<number>`count(distinct ${unlocks.payerId})::int` })
      .from(unlocks)
      .where(
        and(
          eq(unlocks.workerId, workerId),
          gte(unlocks.grantedAt, since),
          // Only count actually-granted/revealed unlocks (a denied row is not a contact).
          sql`${unlocks.status} in ('granted','revealed')`,
        ),
      );
    return rows[0]?.count ?? 0;
  }

  /**
   * #2750 item 6 — the worker's NEW opens in the window, by EVERY company (pilot or not, B7-12):
   * unlock rows granted since `since` that became a contact (granted, revealed, or since lapsed).
   * A re-open of a held contact writes no new grant, so it is not counted; a denied row is not a
   * contact. Tx-scoped, under the worker lock, so concurrent opens of one worker count each other.
   */
  async countOpensSince(tx: Tx, workerId: string, since: Date): Promise<number> {
    const rows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(unlocks)
      .where(
        and(
          eq(unlocks.workerId, workerId),
          gte(unlocks.grantedAt, since),
          sql`${unlocks.status} in ('granted','revealed','expired')`,
        ),
      );
    return rows[0]?.count ?? 0;
  }

  /**
   * #2750 item 6 — the NEW opens this company (its tenant key) made since `since` (the IST day's
   * start for the agency limit). Same row rule as {@link countOpensSince}. On the global pool for
   * the pre-check, or on `tx` for the re-check under {@link lockTenantOpens}.
   */
  async countTenantOpensSince(tenant: TenantKey, since: Date, tx?: Tx): Promise<number> {
    const rows = await (tx ?? this.db)
      .select({ count: sql<number>`count(*)::int` })
      .from(unlocks)
      .where(
        and(
          eq(unlocks.payerId, tenant),
          gte(unlocks.grantedAt, since),
          sql`${unlocks.status} in ('granted','revealed','expired')`,
        ),
      );
    return rows[0]?.count ?? 0;
  }

  /**
   * #2750 item 6 — serialise one agency's new opens for the rest of the transaction, so two opens
   * at once cannot both pass the daily limit. Taken AFTER the worker lock (lock order: worker →
   * this → the wallet row the debit locks), never before it.
   */
  async lockTenantOpens(tx: Tx, tenant: TenantKey): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`tenant_opens:${tenant}`}, 0))`,
    );
  }

  /**
   * Upsert the GRANTED unlock for (tenant, worker) — idempotent on the unique
   * (payer_id, worker_id), which is one unlock per (org, worker) in mode `on`. Tx-scoped. Sets
   * status=granted, the routing token ref, granted_at, expires_at, clears any prior deny_reason.
   */
  async upsertGrant(
    tx: Tx,
    input: {
      /** The tenant key, stamped into `payer_id` (ADR-0053 §5.2 rule 3). */
      payerId: TenantKey;
      workerId: string;
      jobId: string | null;
      /** #2033 — the owned company posting, or null. At most one of jobId / jobPostingId. */
      jobPostingId: string | null;
      routingTokenRef: string;
      grantedAt: Date;
      expiresAt: Date;
    },
  ): Promise<Unlock> {
    const rows = await tx
      .insert(unlocks)
      .values({
        payerId: input.payerId,
        workerId: input.workerId,
        jobId: input.jobId,
        jobPostingId: input.jobPostingId,
        status: "granted" satisfies UnlockStatus,
        denyReason: null,
        routingTokenRef: input.routingTokenRef,
        grantedAt: input.grantedAt,
        expiresAt: input.expiresAt,
      })
      .onConflictDoUpdate({
        target: [unlocks.payerId, unlocks.workerId],
        set: {
          // A (re-)grant is a fresh purchase: it carries THIS request's context, both columns.
          jobId: input.jobId,
          jobPostingId: input.jobPostingId,
          status: "granted" satisfies UnlockStatus,
          denyReason: null,
          routingTokenRef: input.routingTokenRef,
          grantedAt: input.grantedAt,
          expiresAt: input.expiresAt,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to upsert unlock grant");
    return row;
  }

  /**
   * Record a DENIED unlock for the audit spine — idempotent on (tenant, worker). The
   * deny_reason is INTERNAL only (CHECK enforces it is set only on status=denied). It
   * never reaches the payer. Tx-scoped. Returns the row so the caller can event its id.
   */
  async recordDeny(
    tx: Tx,
    input: {
      /** The tenant key, stamped into `payer_id`. */
      payerId: TenantKey;
      workerId: string;
      jobId: string | null;
      /** #2033 — the owned company posting, or null. */
      jobPostingId: string | null;
      denyReason: UnlockDenyReason;
    },
  ): Promise<Unlock> {
    const rows = await tx
      .insert(unlocks)
      .values({
        payerId: input.payerId,
        workerId: input.workerId,
        jobId: input.jobId,
        jobPostingId: input.jobPostingId,
        status: "denied" satisfies UnlockStatus,
        denyReason: input.denyReason,
      })
      .onConflictDoUpdate({
        target: [unlocks.payerId, unlocks.workerId],
        set: {
          // Preserve an existing GRANT — a deny must never downgrade a live grant.
          // We only stamp the deny when there is no granted/revealed row already.
          status: sql`case when ${unlocks.status} in ('granted','revealed') then ${unlocks.status} else 'denied' end`,
          denyReason: sql`case when ${unlocks.status} in ('granted','revealed') then ${unlocks.denyReason} else ${input.denyReason} end`,
          // #2033 — the posting context belongs to the grant it describes: a KEPT grant keeps
          // the context it was bought under, both columns. Every SET expression reads the
          // EXISTING row (Postgres evaluates them against the pre-update tuple), so these
          // CASEs see the same status the two above do.
          jobId: sql`case when ${unlocks.status} in ('granted','revealed') then ${unlocks.jobId} else ${input.jobId}::uuid end`,
          jobPostingId: sql`case when ${unlocks.status} in ('granted','revealed') then ${unlocks.jobPostingId} else ${input.jobPostingId}::uuid end`,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to record unlock deny");
    return row;
  }

  /** Set an unlock to status=revealed and bump reveal_count by 1 (tx-scoped). */
  /**
   * #2747 (ADR-0064 §3.4) — store "open for good" on a grant and its relay row: both expiry dates
   * move to `until`, and nothing else changes (status, reveal count, the routing token). Only ever
   * moves a date LATER, so a re-run is a no-op and a concurrent writer can never shorten one. Run
   * under the worker lock, inside the caller's transaction.
   */
  async extendOpenUntil(tx: Tx, unlockId: string, until: Date): Promise<void> {
    await tx
      .update(unlocks)
      .set({ expiresAt: until, updatedAt: sql`now()` })
      .where(
        and(
          eq(unlocks.id, unlockId),
          inArray(unlocks.status, ["granted", "revealed"]),
          // Column-aware comparisons: the driver maps `until` through the column type (a raw Date
          // inside a hand-written fragment is not serialised).
          or(isNull(unlocks.expiresAt), lt(unlocks.expiresAt, until)),
        ),
      );
    await tx
      .update(unlockRouting)
      .set({ expiresAt: until })
      .where(and(eq(unlockRouting.unlockId, unlockId), lt(unlockRouting.expiresAt, until)));
  }

  async incrementReveal(tx: Tx, unlockId: string): Promise<number> {
    const rows = await tx
      .update(unlocks)
      .set({
        status: "revealed" satisfies UnlockStatus,
        revealCount: sql`${unlocks.revealCount} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(unlocks.id, unlockId))
      .returning({ revealCount: unlocks.revealCount });
    const count = rows[0]?.revealCount;
    if (count === undefined) throw new Error("Failed to increment reveal_count");
    return count;
  }

  /**
   * The routing row an unlock already has, if a reveal opened one (tx-scoped).
   *
   * P-021 (owner ruling 2026-09-21, idempotent direction). `routing_token` is unique, so
   * the reveal path must not blindly re-insert on attempt 2/3 of the per-unlock cap — it
   * reads this first and re-serves the SAME handle. The reveal caller holds the per-worker
   * advisory lock, so two concurrent reveals cannot both miss this; `createRouting`'s
   * ON CONFLICT below is the second wall.
   */
  async findRoutingByUnlock(tx: Tx, unlockId: string): Promise<UnlockRouting | undefined> {
    const rows = await tx
      .select()
      .from(unlockRouting)
      .where(eq(unlockRouting.unlockId, unlockId))
      .limit(1);
    return rows[0];
  }

  /**
   * The routing row for a payer-facing `relay_handle`, or undefined (non-tx read).
   *
   * E0 item 1 (`docs/agent/phases/E0_BUILD.md`): the handle is the ONLY identifier a
   * payer holds, so resolution starts here. Backed by `unlock_routing_relay_handle_uq`
   * (migration 0120) — without it this read seq-scans. NOT tx-scoped: the resolution
   * path takes no advisory lock (it writes nothing on `unlocks`/`unlock_routing`), and
   * every re-check it needs is a plain read. This method is still only reachable from
   * `UnlockService` — the repository stays unexported (F-2/F-5/T5-b).
   */
  async findRoutingByHandle(handle: string): Promise<UnlockRouting | undefined> {
    const rows = await this.db
      .select()
      .from(unlockRouting)
      .where(eq(unlockRouting.relayHandle, handle))
      .limit(1);
    return rows[0];
  }

  /**
   * Write the SERVER-SIDE routing mapping (tx-scoped). PII-FREE: routing token,
   * channel kind, the non-reversible expiring relay handle, expiry — NEVER a phone.
   *
   * IDEMPOTENT ON THE ROUTING TOKEN (P-021, owner ruling 2026-09-21). The token is
   * minted once per GRANT, so a second insert for the same unlock is the same token and
   * belongs to THIS unlock's existing row — return it instead of throwing. The old plain
   * insert made a cap-permitted second reveal a unique-violation 500 (a crash and a
   * status-code oracle). `onConflictDoNothing` + a read-back keeps one row per unlock by
   * contract rather than by accident, for any caller that reaches here without the
   * service's pre-read.
   */
  async createRouting(
    tx: Tx,
    input: {
      unlockId: string;
      routingToken: string;
      channel: RoutingChannel;
      relayHandle: string;
      expiresAt: Date;
    },
  ): Promise<UnlockRouting> {
    const rows = await tx
      .insert(unlockRouting)
      .values({
        unlockId: input.unlockId,
        routingToken: input.routingToken,
        channel: input.channel,
        relayHandle: input.relayHandle,
        expiresAt: input.expiresAt,
      })
      .onConflictDoNothing({ target: unlockRouting.routingToken })
      .returning();
    const row = rows[0];
    if (row) return row;

    // Conflict: this unlock already has its routing row (the token is minted once per
    // grant). Read it back — a second reveal is an idempotent re-read, not an error.
    const existing = await tx
      .select()
      .from(unlockRouting)
      .where(eq(unlockRouting.routingToken, input.routingToken))
      .limit(1);
    const conflicted = existing[0];
    if (!conflicted) throw new Error("Failed to create unlock routing");
    return conflicted;
  }

  // -------------------------------------------------------------------------
  // Credit ledger / balance (mock; F-6). The DB CHECK (balance >= 0) plus the
  // atomic conditional decrement below guarantee balance never goes negative.
  // -------------------------------------------------------------------------

  /**
   * #2749 — the credits the tenant wallet can SPEND now: its balance minus what its lots past
   * `expires_at` still hold (non-tx read, 0 if no row). The unlock path's F-1 precondition reads
   * THIS, not {@link getBalance}: a wallet whose credits are all past due is refused before any
   * worker state is consulted.
   */
  async getSpendableBalance(tenant: TenantKey): Promise<number> {
    return readSpendableCredits(this.db, tenant);
  }

  /** The tenant wallet's current balance (non-tx read), or 0 if no row. */
  async getBalance(tenant: TenantKey): Promise<number> {
    const rows = await this.db
      .select({ balance: payerCredits.balance })
      .from(payerCredits)
      .where(eq(payerCredits.payerId, tenant))
      .limit(1);
    return rows[0]?.balance ?? 0;
  }

  /**
   * The tenant wallet's credit-ledger movements, newest first, bounded by `limit`. The
   * append-only source of truth behind the balance — amounts + opaque ids only (PII-free by
   * table design; no currency/PAN/UPI). Scoped by `payer_id` = the tenant key the resolver gave
   * the SESSION payer, so a payer only ever sees their own org's wallet. Read-only.
   *
   * ⚠️ Selects `price_inr` EXPLICITLY (D-6) ⇒ requires migration 0043. APPLY BEFORE DEPLOY:
   * against an unmigrated DB this read fails outright (not a silently-null column).
   */
  async listCreditLedgerByPayer(tenant: TenantKey, limit: number): Promise<CreditLedgerItem[]> {
    return this.db
      .select({
        id: creditLedger.id,
        delta: creditLedger.delta,
        reason: creditLedger.reason,
        unlock_id: creditLedger.unlockId,
        pack_code: creditLedger.packCode,
        payment_ref: creditLedger.paymentRef,
        price_inr: creditLedger.priceInr, // D-6: the STAMPED charge, never re-priced.
        created_at: creditLedger.createdAt,
      })
      .from(creditLedger)
      .where(eq(creditLedger.payerId, tenant))
      .orderBy(desc(creditLedger.createdAt))
      .limit(limit);
  }

  /**
   * The tenant wallet's OPEN lots (#2749), in the order they are spent: the soonest `expires_at`
   * first, a lot that never expires last. A non-tx read, like {@link getBalance}; a lot past its
   * date still reads here until the spend path or the sweep expires it (at most one sweep tick).
   */
  async listOpenLots(tenant: TenantKey): Promise<OpenLotProjection[]> {
    const rows = await this.db
      .select({
        source: creditLots.source,
        creditsRemaining: creditLots.creditsRemaining,
        creditsGranted: creditLots.creditsGranted,
        expiresAt: creditLots.expiresAt,
        packCode: creditLots.packCode,
      })
      .from(creditLots)
      .where(and(eq(creditLots.payerId, tenant), gt(creditLots.creditsRemaining, 0)))
      .orderBy(...CREDIT_LOT_SPEND_ORDER);
    return rows.map((r) => ({
      source: r.source,
      credits_remaining: r.creditsRemaining,
      credits_granted: r.creditsGranted,
      expires_at: r.expiresAt === null ? null : r.expiresAt.toISOString(),
      pack_code: r.packCode,
    }));
  }

  /**
   * Debit ONE credit (F-6) from the soonest-expiring open lot (#2749): returns the new balance, the
   * lot it came from and any lots it expired first — or `undefined` when no credit is spendable
   * once due lots are counted out, in which case NOTHING was written (no expiry, no lot, no
   * balance; F-1/F-3: the ledger never shows that a request reached the debit). Tx-scoped; the
   * caller writes the `unlock_debit` ledger line with the returned `lotId` and the expired lots'
   * events in the SAME transaction.
   *
   * THE ORG WALLET LOCK (ADR-0053 §6). `spendOneCreditWithinTx` takes the wallet row's lock
   * (`SELECT … FOR UPDATE`), keyed by the tenant, before it reads a lot: in mode `on` two members
   * spending at once queue on the SAME row, and the second reads the first's committed balance
   * and lots — so a team can never overdraw its one wallet, or any lot in it, exactly as one payer
   * never could. The DB CHECKs (balance >= 0, 0 <= remaining <= granted) are the backstop.
   *
   * A due lot is expired here too (one `expired` line, once per lot) — only when a credit is spent.
   *
   * `amount` stays in the signature for its callers; a spend is always one credit (one lot).
   */
  async tryDebit(tx: Tx, tenant: TenantKey, amount: 1): Promise<TryDebitResult | undefined> {
    if (amount !== 1) throw new RangeError(`tryDebit spends one credit (asked for ${amount})`);
    const spent = await spendOneCreditWithinTx(tx, tenant);
    if (!spent.ok) return undefined;
    this.reportRealigned(tenant, spent.alignment);
    return {
      ok: true,
      balanceAfter: spent.balanceAfter,
      lotId: spent.lotId,
      expiredLots: spent.expiredLots,
    };
  }

  /**
   * #2750 item 2 — debit `credits` at once (the higher cost of a contact), across lots if need be.
   * The same contract as {@link tryDebit}: tenant-keyed, under the wallet row lock, and
   * `undefined` with NOTHING written when fewer than `credits` are spendable (never a partial
   * spend). The caller writes ONE `unlock_debit` line per take, each naming its lot.
   */
  async tryDebitCredits(
    tx: Tx,
    tenant: TenantKey,
    credits: number,
  ): Promise<TryDebitCreditsResult | undefined> {
    const spent = await spendCreditsWithinTx(tx, tenant, credits);
    if (!spent.ok) return undefined;
    this.reportRealigned(tenant, spent.alignment);
    return { balanceAfter: spent.balanceAfter, takes: spent.takes, expiredLots: spent.expiredLots };
  }

  /**
   * Append a credit-ledger movement (tx-scoped — the source of truth). `payerId` is the WALLET
   * (the tenant key) the movement belongs to — the same key as the balance it moved, so
   * `balance = Σ delta` per `payer_id` holds across the flip and across a rollback (ADR-0053 §6).
   */
  async appendLedger(
    tx: Tx,
    input: {
      payerId: TenantKey;
      delta: number;
      reason: CreditReason;
      unlockId?: string | null;
      packCode?: string | null;
      paymentRef?: string | null;
      /** #2749 — the lot the movement spent from ({@link tryDebit}'s `lotId`). */
      lotId?: string | null;
      /** #2750 item 5 — the exactly-once key (`waived:<unlock id>` for a waived open). */
      idempotencyKey?: string | null;
    },
  ): Promise<void> {
    await tx.insert(creditLedger).values({
      payerId: input.payerId,
      delta: input.delta,
      reason: input.reason,
      unlockId: input.unlockId ?? null,
      packCode: input.packCode ?? null,
      paymentRef: input.paymentRef ?? null,
      lotId: input.lotId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
    });
  }

  /**
   * Credit a pack purchase / ops grant (NON-tx convenience for the mock top-up
   * endpoint): one `pack` lot (expiring `validityDays` after the grant when the pack sets one,
   * #2749 PR 3; else never), one ledger line naming it and the balance, in ONE transaction.
   * Returns the new balance.
   *
   * ⚠️ Inserts `price_inr` (D-6, migration 0043) and `lot_id` (#2749, migration 0174)
   * EXPLICITLY ⇒ APPLY BEFORE DEPLOY: against an unmigrated DB EVERY pack purchase fails.
   */
  async creditPack(
    input: {
      /** The wallet credited: the tenant key (ADR-0053 W1 — a member's purchase credits the org). */
      payerId: TenantKey;
    } & WalletCredit,
  ): Promise<number> {
    const { payerId, ...credit } = input;
    const grant = await this.db.transaction((tx) => this.creditWalletWithinTx(tx, payerId, credit));
    return grant.balanceAfter;
  }

  /**
   * The ONE wallet-credit implementation, inside the CALLER's transaction (the F-6 atomicity
   * shape of {@link tryDebit}): `grantCreditsWithinTx` locks the wallet row, aligns its lots,
   * writes one `pack` lot (for a paid order, naming it — one lot per order), one ledger line
   * naming the lot, and the balance, all on the SAME key. PRIVATE, and typed so only an
   * authority names the wallet: a resolver-minted
   * {@link TenantKey} ({@link creditPack}) or the row a payment-order claim RETURNED
   * ({@link claimAndCreditPaymentOrderWithinTx}). No caller can hand it an order it built.
   *
   * WHY TX-SCOPED: the real-payment grant must commit in the SAME transaction as the
   * `payment_orders` 'created' → 'paid' flip. Separate transactions would let a crash leave a
   * paid order with no credits (the payer paid and got nothing) or credits with an unpaid order
   * (a free grant a retried webhook would repeat). One transaction makes both impossible.
   */
  private async creditWalletWithinTx(
    tx: Tx,
    wallet: TenantKey | PaymentOrder,
    credit: WalletCredit,
  ): Promise<WalletGrantResult> {
    const walletKey = typeof wallet === "string" ? wallet : wallet.payerId;
    const grant = await grantCreditsWithinTx(tx, {
      payerId: walletKey,
      credits: credit.credits,
      lot: {
        source: "pack",
        packCode: credit.packCode,
        paymentOrderId: typeof wallet === "string" ? null : wallet.id,
        // #2749 PR 3: `grant time + validityDays` on the DB clock (the mock pack's live tier, or
        // the order's stamped `credit_validity_days`); null = never expires.
        validityDays: credit.validityDays ?? null,
      },
      ledger: {
        reason: credit.reason,
        packCode: credit.packCode,
        paymentRef: credit.paymentRef,
        priceInr: credit.priceInr ?? null,
        idempotencyKey: credit.idempotencyKey ?? null,
      },
    });
    this.reportRealigned(walletKey, grant.alignment);
    return grant;
  }

  /**
   * Log, at ERROR, that the wallet helper re-aligned a wallet's lots with its balance (ids and
   * numbers, the stable `credit-wallet: lots out of step with balance` prefix). The self-heal
   * stays; after the 0174 apply-to-deploy window this should never fire, and any occurrence
   * means some writer moved a balance without going through the wallet helpers.
   */
  private reportRealigned(walletKey: string, alignment: LotAlignment): void {
    const line = lotAlignmentWarning(walletKey, alignment);
    if (line !== null) this.walletLog.error(line);
  }

  // ===========================================================================
  // credit_lots expiry sweep (#2749 item 4) — the `credit-lot-expiry` processor's two calls
  // ===========================================================================

  /**
   * Up to `limit` wallets holding a lot past its `expires_at`, the longest-overdue first — the
   * sweep's work list. Keys are READ FROM `credit_lots` (see {@link StoredWalletKey}), and only
   * for wallets that have a `payer_credits` row (an orphan lot can never be expired, so it must
   * not take a slot on every tick).
   */
  async findWalletsWithDueLots(limit: number): Promise<StoredWalletKey[]> {
    const keys = await findWalletsWithDueLots(this.db, limit);
    return keys as StoredWalletKey[];
  }

  /** Wallet keys holding a due lot but no `payer_credits` row — skipped by the sweep. */
  async countOrphanWalletsWithDueLots(): Promise<number> {
    return countOrphanWalletsWithDueLots(this.db);
  }

  /**
   * Expire one wallet's due lots in its OWN transaction: lock the wallet row → align → one
   * `expired` line per due lot → balance down → then `withinTx` (the sweep's events) on the SAME
   * transaction, so a committed expiry can never lose its event and a failed event rolls the
   * expiry back. The same lock order as a spend, so a sweep racing an unlock on the same wallet
   * waits on the row lock and never deadlocks.
   */
  async expireDueLotsForWallet(
    wallet: StoredWalletKey,
    withinTx?: (tx: Tx, result: WalletExpiryResult) => Promise<void>,
  ): Promise<WalletExpiryResult> {
    const result = await this.db.transaction(async (tx) => {
      const done = await expireWalletWithinTx(tx, wallet);
      if (withinTx) await withinTx(tx, done);
      return done;
    });
    this.reportRealigned(wallet, result.alignment);
    return result;
  }

  // ===========================================================================
  // payment_orders — REAL-money order rows (Razorpay). The UNIQUE
  // (provider, provider_order_id) index is THE payment idempotency key.
  // ===========================================================================

  /**
   * Persist a freshly-created provider order.
   *
   * BOTH SIDES OF THE TRANSACTION ARE STAMPED HERE, once: `amountInr` is the ₹ the pricing
   * catalog resolved at creation, and `creditsGranted` is what that ₹ buys. The settle path
   * reads BOTH off this row and never re-consults the catalog, so an ops price/size edit
   * between creation and capture cannot change what an existing order is worth. A receipt
   * carrying only the amount and not the goods is not a receipt.
   *
   * The WALLET is stamped here too (ADR-0053 §6): `payer_id` is the tenant key at intent, and
   * settlement credits that wallet and never re-resolves — an order created before the flip
   * settles into the wallet it was created for.
   *
   * #2749 (migration 0176): the GST price line in paise (`money`; `amountInr` is then its
   * whole-rupee total — the CHECKs refuse anything else), the pack's credit validity, and the
   * purchase origin are stamped in the same insert. All optional here so a caller that has none
   * (a test fixture) writes what a pre-0176 order held; the gateway always passes them.
   * `originJobPostingId` must already be proven the tenant's own (the service does it).
   */
  async createPaymentOrder(input: {
    /**
     * The row id, when the caller minted it first (the gateway does, so the provider order's
     * receipt and notes carry the SAME id as this row). Absent = the DB default.
     */
    id?: string;
    payerId: TenantKey;
    packCode: string;
    amountInr: number;
    creditsGranted: number;
    providerOrderId: string;
    provider?: string;
    money?: PaymentOrderMoney | null;
    creditValidityDays?: number | null;
    origin?: PaymentOrderOrigin | null;
    originJobPostingId?: string | null;
  }): Promise<PaymentOrder> {
    const rows = await this.db
      .insert(paymentOrders)
      .values({
        ...(input.id !== undefined ? { id: input.id } : {}),
        payerId: input.payerId,
        productKind: "credit_pack",
        packCode: input.packCode,
        amountInr: input.amountInr,
        creditsGranted: input.creditsGranted,
        provider: input.provider ?? RAZORPAY_PROVIDER,
        providerOrderId: input.providerOrderId,
        status: "created",
        taxablePaise: input.money?.taxablePaise ?? null,
        gstPaise: input.money?.gstPaise ?? null,
        roundOffPaise: input.money?.roundOffPaise ?? null,
        totalPaise: input.money?.totalPaise ?? null,
        gstRateBps: input.money?.gstRateBps ?? null,
        creditValidityDays: input.creditValidityDays ?? null,
        origin: input.origin ?? null,
        originJobPostingId: input.originJobPostingId ?? null,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("Failed to persist payment order");
    return row;
  }

  /** Look up an order by its provider id (the unique key). PII-free row. */
  async findPaymentOrder(
    providerOrderId: string,
    provider: string = RAZORPAY_PROVIDER,
  ): Promise<PaymentOrder | undefined> {
    const rows = await this.db
      .select()
      .from(paymentOrders)
      .where(
        and(
          eq(paymentOrders.provider, provider),
          eq(paymentOrders.providerOrderId, providerOrderId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * SETTLEMENT (ADR-0053 §6): claim the order with the compare-and-set below and, in the SAME
   * transaction, credit the wallet the CLAIMED row names — the `payer_id` stamped at intent,
   * read off the UPDATE's RETURNING row and never re-resolved. An order created before the flip
   * therefore settles into the wallet it was created for, and an order a team member created
   * settles into the org wallet. The credits and the ₹ are the row's stamped values (D-6).
   *
   * The wallet cannot come from anywhere else: the caller names the PROVIDER order only, and the
   * credit helper is private. `undefined` when the claim matched no row (already paid, unknown,
   * or a concurrent settler won) — then nothing is credited.
   *
   * Exactly-once, layer 3: the ledger line carries `payment_order:<row id>` (checked under the
   * wallet lock, with `credit_ledger_idempotency_key_uq` as the backstop) and the lot names the
   * order under the unique `credit_lots_payment_order_uq`, so even a bypassed claim could not
   * credit an order twice: a key already on the ledger grants nothing and reads as a lost race.
   */
  async claimAndCreditPaymentOrderWithinTx(
    tx: Tx,
    input: {
      providerOrderId: string;
      providerPaymentRef: string;
      provider?: string;
      /**
       * #2750 item 9 — for a company under the credit rules: give back, in this transaction, the
       * credits that expired unused on its earlier real paid packs (`returnedCreditsMax`,
       * `returnedCreditsWindowMonths`). Absent = no return (every other company, today).
       */
      packReturn?: { max: number; windowMonths: number };
    },
  ): Promise<
    { order: PaymentOrder; balanceAfter: number; packReturn: PackReturnResult | null } | undefined
  > {
    const claimed = await this.claimPaymentOrderPaidWithinTx(tx, input);
    if (!claimed) return undefined;
    const grant = await this.creditWalletWithinTx(tx, claimed, {
      credits: claimed.creditsGranted,
      reason: "pack_purchase",
      packCode: claimed.packCode,
      // OPAQUE provider payment id only (`pay_*`) — never a card/UPI/contact value.
      paymentRef: input.providerPaymentRef,
      priceInr: claimed.amountInr,
      idempotencyKey: `payment_order:${claimed.id}`,
      // #2749 PR 3: the validity STAMPED at order time (hazard 8: the catalogue is not re-read),
      // counted from this settle on the DB clock. Null (every pre-0176 order) = never expires.
      validityDays: claimed.creditValidityDays,
    });
    // Already credited under this order's key: nothing was granted now (the caller re-reads).
    if (!grant.applied) return undefined;
    if (input.packReturn === undefined) {
      return { order: claimed, balanceAfter: grant.balanceAfter, packReturn: null };
    }
    // #2750 item 9 — after the new lot exists, under the same wallet lock, on the same key space.
    const packReturn = await returnExpiredPackCreditsWithinTx(tx, {
      payerId: claimed.payerId,
      paymentOrderId: claimed.id,
      newLotId: grant.lotId,
      paymentRef: input.providerPaymentRef,
      max: input.packReturn.max,
      windowMonths: input.packReturn.windowMonths,
    });
    return {
      order: claimed,
      balanceAfter: packReturn.balanceAfter ?? grant.balanceAfter,
      packReturn,
    };
  }

  /**
   * THE RACE CLOSURE — an atomic compare-and-set from `created` or `failed` to 'paid'.
   *
   * Returns the claimed row to EXACTLY ONE caller and `undefined` to every other, whether
   * the loser is a Razorpay webhook retry, a second webhook delivery, the browser verify
   * call, or all three arriving concurrently.
   *
   * #2749 hardening 5: a `held` order (a capture of the wrong amount) matches nothing here, so
   * neither a webhook replay nor a verify can ever grant it. (Before 0176 this matched any status
   * but `paid`; the two it now matches are the same two that existed then.)
   *
   * WHY THIS IS SAFE UNDER CONCURRENCY (READ COMMITTED, the Postgres default): two
   * transactions issue this UPDATE against the same row. The first takes the row lock and
   * sets status='paid'. The second BLOCKS on that lock; when the first commits, Postgres
   * re-evaluates the second's WHERE clause against the NEW row version (EvalPlanQual) —
   * `status <> 'paid'` is now false, so it updates 0 rows and returns undefined. There is
   * no read-then-write window for a racer to slip through, because the read and the write
   * are the same statement.
   *
   * The caller performs the credit grant in the SAME transaction as this call, so "claimed
   * the order" and "granted the credits" commit or roll back together.
   */
  private async claimPaymentOrderPaidWithinTx(
    tx: Tx,
    input: { providerOrderId: string; providerPaymentRef: string; provider?: string },
  ): Promise<PaymentOrder | undefined> {
    const rows = await tx
      .update(paymentOrders)
      .set({
        status: "paid",
        providerPaymentRef: input.providerPaymentRef,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(paymentOrders.provider, input.provider ?? RAZORPAY_PROVIDER),
          eq(paymentOrders.providerOrderId, input.providerOrderId),
          // The compare half of the compare-and-set. A row already 'paid' — or 'held' — matches
          // nothing.
          inArray(paymentOrders.status, [...CAPTURABLE_ORDER_STATUSES]),
        ),
      )
      .returning();
    return rows[0];
  }

  /**
   * #2749 hardening 5 — HOLD an order whose capture carried the wrong amount: the same single-
   * statement compare-and-set as the claim, from `created` or `failed` to `held`, stamping the
   * provider payment id (opaque — what ops need to refund it in the Razorpay dashboard). Nothing is
   * granted, here or ever: the claim never matches `held`. Returns the held row to exactly ONE
   * caller; `undefined` when the order is unknown, already paid, already held, or a concurrent
   * settle won (a matching capture on the same order), so a replayed mismatch emits nothing new.
   *
   * `withinTx` (the `payment.held` event) runs on the SAME transaction, only for the call that
   * held the row, so the hold and its event commit together: an event that cannot be written rolls
   * the hold back, the webhook answers 5xx, and Razorpay's redelivery tries both again.
   */
  async holdPaymentOrder(
    input: HoldPaymentOrderInput,
    withinTx?: (tx: Tx, held: PaymentOrder) => Promise<void>,
  ): Promise<PaymentOrder | undefined> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .update(paymentOrders)
        .set({
          status: "held",
          providerPaymentRef: input.providerPaymentRef,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(paymentOrders.provider, input.provider ?? RAZORPAY_PROVIDER),
            eq(paymentOrders.providerOrderId, input.providerOrderId),
            inArray(paymentOrders.status, [...CAPTURABLE_ORDER_STATUSES]),
          ),
        )
        .returning();
      const held = rows[0];
      if (held && withinTx) await withinTx(tx, held);
      return held;
    });
  }

  /**
   * Mark an order failed — but ONLY from a non-terminal state (`created`, or an earlier
   * `failed`). The same compare-and-set discipline as the grant: a late/out-of-order
   * `payment.failed` delivery must never be able to walk back an order whose capture already
   * granted credits (Razorpay does not guarantee webhook ordering), nor turn a `held` order —
   * money captured, awaiting ops — into a `failed` one that reads as "no money moved".
   */
  async markPaymentOrderFailed(
    providerOrderId: string,
    provider: string = RAZORPAY_PROVIDER,
  ): Promise<PaymentOrder | undefined> {
    const rows = await this.db
      .update(paymentOrders)
      .set({ status: "failed", updatedAt: sql`now()` })
      .where(
        and(
          eq(paymentOrders.provider, provider),
          eq(paymentOrders.providerOrderId, providerOrderId),
          inArray(paymentOrders.status, [...CAPTURABLE_ORDER_STATUSES]),
        ),
      )
      .returning();
    return rows[0];
  }

  /** Re-export for callers that narrow on the lifecycle without importing the table module. */
  static isPaid(status: PaymentOrderStatus): boolean {
    return status === "paid";
  }

  /** PII-free list of a tenant's unlocks (ops read). NO routing token resolved. */
  async listByPayer(tenant: TenantKey): Promise<UnlockProjection[]> {
    const rows = await this.db
      .select()
      .from(unlocks)
      .where(eq(unlocks.payerId, tenant))
      .orderBy(desc(unlocks.createdAt)) // deterministic newest-first under the cap
      .limit(OPS_LIST_CAP); // bound an otherwise-unbounded ops read
    return rows.map((u) => this.project(u));
  }

  /**
   * #2033 — the tenant's unlocks whose STORED status is one of `statuses`, newest first, capped.
   * The filter runs in SQL so rows outside the set never reach the caller AND never consume
   * the cap. Which statuses a caller may see is the service's rule, not this method's.
   * Served by `unlocks_payer_id_idx`; the status test is a residual filter on that tenant's rows.
   */
  async listByPayerWithStatus(
    tenant: TenantKey,
    statuses: readonly UnlockStatus[],
  ): Promise<UnlockProjection[]> {
    // An empty IN () is invalid SQL and would mean "nothing" anyway.
    if (statuses.length === 0) return [];
    const rows = await this.db
      .select()
      .from(unlocks)
      .where(and(eq(unlocks.payerId, tenant), inArray(unlocks.status, [...statuses])))
      .orderBy(desc(unlocks.createdAt))
      .limit(OPS_LIST_CAP);
    return rows.map((u) => this.project(u));
  }

  /** A single unlock projection by id (ops read), or undefined. PII-free. */
  async getProjection(unlockId: string): Promise<UnlockProjection | undefined> {
    const rows = await this.db.select().from(unlocks).where(eq(unlocks.id, unlockId)).limit(1);
    const row = rows[0];
    return row ? this.project(row) : undefined;
  }

  private project(u: Unlock): UnlockProjection {
    return {
      unlock_id: u.id,
      payer_id: u.payerId,
      worker_id: u.workerId,
      job_id: u.jobId,
      job_posting_id: u.jobPostingId,
      status: u.status,
      reveal_count: u.revealCount,
      granted_at: u.grantedAt,
      expires_at: u.expiresAt,
      created_at: u.createdAt,
    };
  }
}
