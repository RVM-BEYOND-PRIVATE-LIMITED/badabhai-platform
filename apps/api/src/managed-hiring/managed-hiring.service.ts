import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
  ServiceUnavailableException,
} from "@nestjs/common";
import type {
  Database,
  ManagedHiringInterestRow,
  ManagedHiringOrderRow,
  PaymentOrder,
} from "@badabhai/db";
import type { PayloadInputOf } from "@badabhai/event-schema";
import {
  gstPriceLine,
  managedHiringClock,
  type Catalog,
  type GstPriceLine,
  type ManagedHiringTier as CatalogTier,
} from "@badabhai/pricing";
import {
  MANAGED_HIRING_OPEN_STATUSES,
  type ManagedHiringOrderStatus,
  type ManagedHiringTier,
  type PaymentOrderOrigin,
  type VacancyBand,
} from "@badabhai/types";
import { ADMIN_ACTION_CODES } from "../admin/admin-action-codes";
import { decodeEntityCursor, encodeEntityCursor } from "../admin/admin-entities.cursor";
import { sqlStateOf } from "../common/db-error";
import type { RequestContext } from "../common/request-context";
import { hasActiveConsent } from "../consent/consent-active";
import { ConsentRepository } from "../consent/consent.repository";
import { EventsService } from "../events/events.service";
import { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import type { PayerTenantScope, TenantKey } from "../payers/payer-tenant-scope";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { assertExpectedPrice } from "../pricing/charge-price";
import { isRejectedCatalogRow } from "../pricing/credit-pack-sale";
import { PricingService } from "../pricing/pricing.service";
import {
  PaidOrderSettlers,
  type SettleContext,
  type SettleTx,
} from "../unlocks/paid-order-settlers";
import type { RealProductOrderHandoff } from "../unlocks/payment-gateway";
import { ProductCheckoutService } from "../unlocks/product-checkout.service";
import { ManagedHiringMailer, type ManagedHiringNoticeKind } from "./managed-hiring.mailer";
import {
  ManagedHiringRepository,
  type AdminOrderFilter,
  type ManagedHiringJobRow,
  type OrderWithCount,
} from "./managed-hiring.repository";
import { MANAGED_HIRING_TERMS, managedHiringTierFor } from "./managed-hiring-tier";

const UNDEFINED_TABLE = "42P01";

/** The catalogue product the quote and the order price from. */
export const MANAGED_HIRING_PRODUCT = "managed_hiring";

/** A refusal with a stable machine `reason` (the client branches on it, never on the text). */
function refused(
  Ex: typeof ConflictException | typeof ForbiddenException | typeof BadRequestException,
  reason: string,
  message: string,
): never {
  throw new Ex({ reason, message });
}

// ── Response shapes ──────────────────────────────────────────────────────────────────────────

export interface ManagedHiringPriceDto {
  /** The list price before GST, whole rupees (what `expected_price_inr` confirms). */
  price_inr: number;
  taxable_paise: number;
  gst_paise: number;
  round_off_paise: number;
  /** What the checkout charges, GST included, in paise. */
  total_paise: number;
  gst_rate_bps: number;
}

export interface ManagedHiringOpenOrderRef {
  order_id: string;
  status: ManagedHiringOrderStatus;
}

/** `GET /payer/managed-hiring/quote?job_posting_id=` — decided by the server. */
export type ManagedHiringQuoteDto =
  | {
      job_posting_id: string;
      offer: "order";
      tier: ManagedHiringTier;
      price: ManagedHiringPriceDto;
      target_count: number;
      working_days: number;
      extension_days: number;
      terms: string;
      /** The job's open order, when one exists (a second order is refused until it ends). */
      open_order: ManagedHiringOpenOrderRef | null;
    }
  | {
      job_posting_id: string;
      offer: "callback";
      vacancy_band: VacancyBand;
      terms: string;
      /** The job's callback request, when it already asked. */
      callback_request_id: string | null;
    };

export interface ManagedHiringCheckoutDto {
  order_id: string;
  /** Razorpay's `order_*` id, for checkout.js. */
  provider_order_id: string;
  key_id: string;
  /** Paise, GST included — what checkout.js expects. */
  amount: number;
  amount_inr: number;
  currency: string;
  price: Omit<ManagedHiringPriceDto, "price_inr">;
}

/** One worker on the company's tracker. Never the staff note or the staff member. */
export interface PayerTrackerWorkerDto {
  worker_id: string;
  confirmed_at: string;
}

export interface PayerManagedHiringOrderDto {
  order_id: string;
  job_posting_id: string;
  tier: ManagedHiringTier;
  status: ManagedHiringOrderStatus;
  price_inr: number;
  target_count: number;
  confirmed_count: number;
  started_at: string | null;
  due_at: string | null;
  extended_until: string | null;
  ended_at: string | null;
  terms: string;
  /** Only while `created` (unpaid) and real payments are live: the checkout to finish paying. */
  checkout: ManagedHiringCheckoutDto | null;
  workers: PayerTrackerWorkerDto[];
}

export interface AdminTrackerWorkerDto {
  worker_id: string;
  confirmed_at: string;
  confirmed_by: string;
  note: string;
}

export interface AdminManagedHiringOrderDto {
  order_id: string;
  payer_id: string;
  job_posting_id: string;
  tier: ManagedHiringTier;
  status: ManagedHiringOrderStatus;
  price_inr: number;
  target_count: number;
  confirmed_count: number;
  started_at: string | null;
  due_at: string | null;
  extended_until: string | null;
  ended_at: string | null;
  is_test: boolean;
  created_at: string;
}

export interface AdminManagedHiringOrderDetailDto extends AdminManagedHiringOrderDto {
  workers: AdminTrackerWorkerDto[];
}

export interface CallbackRequestDto {
  request_id: string;
  payer_id: string;
  job_posting_id: string;
  vacancy_band: VacancyBand;
  reason: "above_largest_tier";
  is_test: boolean;
  created_at: string;
}

export interface ManagedHiringSweepResult {
  readonly skipped: boolean;
  readonly due: number;
  readonly moved: number;
  readonly failed: number;
}

/** What `prepare` hands the settle transaction (#2751 item 6). */
interface ActivationPlan {
  readonly orderId: string;
  readonly holidays: readonly string[];
}

/** A change to tell the company about once its transaction committed. */
interface Notice {
  readonly order: ManagedHiringOrderRow;
  readonly kind: ManagedHiringNoticeKind;
  readonly confirmedCount: number;
}

/**
 * #2751 items 4 to 13 — MANAGED HIRING (brief section 2 and 4B.9). A company pays, per job, for
 * BadaBhai's desk to find workers who confirm by phone that they are interested: `target_count`
 * (5) within `working_days` (7) working days, with a free extension to day `extension_days` (30).
 * The service NEVER promises a hire.
 *
 * BEHIND THE `managed_hiring` SWITCH (D5: off, pilot companies first). Off for a company, every
 * payer route answers the neutral 404 and nothing names the tables; off everywhere, the admin
 * routes answer 404 and the sweep idles. The checkout also needs REAL payments: on the mock path
 * the product is not offered at all (a mock order would be a free service order). The settle of an
 * order already paid is never gated.
 *
 * THE SERVER DECIDES the tier (from the job: vacancy band and level needed), the price (the
 * catalogue's list price, GST through `gstPriceLine`), the clock (Monday to Saturday in IST, the
 * catalogue's holiday list) and every text. Money is integer paise in every new field.
 */
@Injectable()
export class ManagedHiringService implements OnModuleInit {
  private readonly logger = new Logger(ManagedHiringService.name);

  constructor(
    private readonly repo: ManagedHiringRepository,
    private readonly rollout: FeatureRolloutService,
    private readonly tenancy: PayerTenantScopeService,
    private readonly pricing: PricingService,
    private readonly checkout: ProductCheckoutService,
    private readonly settlers: PaidOrderSettlers,
    private readonly consents: ConsentRepository,
    private readonly events: EventsService,
    private readonly mailer: ManagedHiringMailer,
  ) {}

  /** #2751 item 6 — a captured `managed_hiring` payment activates its order (the ONE settle path). */
  onModuleInit(): void {
    this.settlers.register<ActivationPlan>("managed_hiring", {
      prepare: (order) => this.prepareActivation(order),
      settleWithinTx: (tx, order, plan, ctx) => this.activateWithinTx(tx, order, plan, ctx),
      afterCommit: (order) => this.notifyActivated(order),
    });
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // The company
  // ════════════════════════════════════════════════════════════════════════════════════════

  /** `GET /payer/managed-hiring/quote` — what Managed Hiring offers for one of the company's jobs. */
  async quote(actorPayerId: string, jobPostingId: string): Promise<ManagedHiringQuoteDto> {
    const scope = await this.liveScope(actorPayerId);
    return this.guardTable(async () => {
      await this.assertEmployer(scope.tenantKey);
      const job = await this.ownOpenJob(scope.tenantKey, jobPostingId);
      const choice = managedHiringTierFor(job);
      if (choice.kind === "callback") {
        const asked = await this.repo.findCallbackForJob(job.id);
        return {
          job_posting_id: job.id,
          offer: "callback",
          vacancy_band: job.vacancyBand,
          terms: MANAGED_HIRING_TERMS,
          callback_request_id: asked?.id ?? null,
        };
      }
      const priced = await this.priceTier(choice.tier);
      const open = await this.repo.findOpenOrderForJob(job.id);
      return {
        job_posting_id: job.id,
        offer: "order",
        tier: choice.tier,
        price: priceDto(priced.tier.priceInr, priced.line),
        target_count: priced.tier.targetCount,
        working_days: priced.tier.workingDays,
        extension_days: priced.tier.extensionDays,
        terms: MANAGED_HIRING_TERMS,
        open_order: open ? { order_id: open.id, status: open.status } : null,
      };
    });
  }

  /**
   * `POST /payer/managed-hiring/orders` — start the checkout for one job. The order is `created`
   * (unpaid) with its `payment_orders` row in ONE transaction; it starts only when the payment is
   * captured. ONE OPEN ORDER PER JOB: an unpaid order of the same tier is handed back (no second
   * provider order); a running one is a 409.
   */
  async createOrder(
    actorPayerId: string,
    input: { jobPostingId: string; expectedPriceInr?: number; origin?: PaymentOrderOrigin },
    ctx: RequestContext,
  ): Promise<ManagedHiringCheckoutDto> {
    const scope = await this.liveScope(actorPayerId);
    return this.guardTable(async () => {
      const company = await this.assertEmployer(scope.tenantKey);
      const job = await this.ownOpenJob(scope.tenantKey, input.jobPostingId);
      const choice = managedHiringTierFor(job);
      if (choice.kind === "callback") {
        refused(
          ConflictException,
          "above_largest_tier",
          "This job has more vacancies than Managed Hiring covers; request a call instead",
        );
      }
      const priced = await this.priceTier(choice.tier);
      // #2085: the price the company confirmed must be the list price before GST.
      assertExpectedPrice(input.expectedPriceInr, priced.tier.priceInr);

      const open = await this.repo.findOpenOrderForJob(job.id);
      if (open) return this.handBack(open, choice.tier);

      const { handoff, result } = await this.checkout.create(
        scope.tenantKey,
        {
          productKind: "managed_hiring",
          line: priced.line,
          productCode: `${MANAGED_HIRING_PRODUCT}:${choice.tier}`,
          origin: { origin: input.origin ?? null, jobPostingId: job.id },
        },
        (tx, paymentOrder) =>
          this.insertOrderWithinTx(tx as unknown as Database, {
            scope,
            jobPostingId: job.id,
            tier: choice.tier,
            paymentOrder,
            priced,
            isTest: company.isTest,
            ctx,
          }),
      );
      return checkoutDto(result.id, handoff);
    });
  }

  /** `GET /payer/managed-hiring/orders/:id` — the company's order, its clock and its tracker. */
  async getOrder(actorPayerId: string, orderId: string): Promise<PayerManagedHiringOrderDto> {
    const scope = await this.liveScope(actorPayerId);
    return this.guardTable(async () => {
      const order = await this.repo.findOrderForTenant(scope.tenantKey, orderId);
      if (!order) throw new NotFoundException();
      return this.payerOrderDto(order);
    });
  }

  /** `GET /payer/managed-hiring/orders?job_posting_id=` — the company's orders, newest first. */
  async listOrders(
    actorPayerId: string,
    jobPostingId: string | undefined,
  ): Promise<{ orders: PayerManagedHiringOrderDto[] }> {
    const scope = await this.liveScope(actorPayerId);
    return this.guardTable(async () => {
      const rows = await this.repo.listOrdersForTenant(scope.tenantKey, jobPostingId, 50);
      return { orders: await Promise.all(rows.map((r) => this.payerOrderDto(r))) };
    });
  }

  /**
   * `POST /payer/managed-hiring/callback-requests` — a job above the largest tier asks for a call
   * (brief 7 and 12, B7-05). Stored once per job, and an admin is alerted
   * (`managed_hiring.callback_requested`, on the dashboard's breach counter). Asking again returns
   * the first request and alerts nobody.
   */
  async requestCallback(
    actorPayerId: string,
    jobPostingId: string,
    ctx: RequestContext,
  ): Promise<{ request_id: string; job_posting_id: string; created: boolean }> {
    const scope = await this.liveScope(actorPayerId);
    return this.guardTable(async () => {
      const company = await this.assertEmployer(scope.tenantKey);
      const job = await this.ownOpenJob(scope.tenantKey, jobPostingId);
      if (managedHiringTierFor(job).kind !== "callback") {
        refused(
          ConflictException,
          "tier_available",
          "Managed Hiring can be bought for this job; no call request is needed",
        );
      }
      const inserted = await this.repo.withTransaction(async (tx) => {
        const row = await this.repo.insertCallbackWithinTx(tx, {
          payerId: scope.tenantKey,
          requestedBy: scope.actorPayerId,
          jobPostingId: job.id,
          vacancyBand: job.vacancyBand,
          reason: "above_largest_tier",
          isTest: company.isTest,
        });
        if (!row) return undefined;
        const payload: PayloadInputOf<"managed_hiring.callback_requested"> = {
          request_id: row.id,
          payer_id: scope.tenantKey,
          job_posting_id: job.id,
          vacancy_band: job.vacancyBand,
          reason: "above_largest_tier",
        };
        await this.events.emit({
          event_name: "managed_hiring.callback_requested",
          actor: { actor_type: "payer", actor_id: scope.actorPayerId },
          subject: { subject_type: "job_posting", subject_id: job.id },
          payload,
          idempotencyKey: `managed_hiring.callback_requested:${job.id}`,
          correlationId: ctx.correlationId,
          ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
          tx,
        });
        return row;
      });
      if (inserted) {
        // The admin alert's loud half; the event is its record (and the dashboard's count).
        this.logger.warn(
          `managed hiring callback requested: an admin should call the company request=${inserted.id} job=${job.id} band=${job.vacancyBand}`,
        );
        return { request_id: inserted.id, job_posting_id: job.id, created: true };
      }
      const first = await this.repo.findCallbackForJob(job.id);
      if (!first) throw new ServiceUnavailableException();
      return { request_id: first.id, job_posting_id: job.id, created: false };
    });
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // The desk (admin)
  // ════════════════════════════════════════════════════════════════════════════════════════

  async listOrdersForAdmin(filter: {
    status: AdminOrderFilter;
    cursor?: string;
    limit: number;
  }): Promise<{ orders: AdminManagedHiringOrderDto[]; next_cursor: string | null }> {
    this.assertLiveAnywhere();
    return this.guardTable(async () => {
      const rows = await this.repo.listOrdersForAdmin({
        status: filter.status,
        after: decodeEntityCursor(filter.cursor),
        limit: filter.limit + 1,
      });
      const page = rows.slice(0, filter.limit);
      const last = page.at(-1);
      return {
        orders: page.map(adminOrderDto),
        next_cursor:
          rows.length > filter.limit && last
            ? encodeEntityCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
            : null,
      };
    });
  }

  async getOrderForAdmin(orderId: string): Promise<AdminManagedHiringOrderDetailDto> {
    this.assertLiveAnywhere();
    return this.guardTable(async () => {
      const order = await this.repo.getOrder(orderId);
      if (!order) throw new NotFoundException();
      const workers = await this.repo.listInterest(order.id);
      return { ...adminOrderDto(order), workers: workers.map(adminWorkerDto) };
    });
  }

  /**
   * `POST /admin/managed-hiring/orders/:id/interest` — staff add a worker they reached by phone who
   * confirmed interest. Refused (409, a stable `reason`) unless: the order's clock is running
   * (`active` or `extended`), he exists and is not deleted or suspended, he holds the
   * `employer_sharing` consent, and — an RVM student may be reached only by applying (brief 6) — an
   * actively linked RVM student applied to THIS job. One row per order and worker.
   *
   * During the free extension, the confirmation that reaches the target marks the order `met` at
   * once (owner ruling 2026-11-18); before the deadline the order stays open until the sweep.
   */
  async addInterest(
    adminId: string,
    orderId: string,
    workerId: string,
    note: string,
    ctx: RequestContext,
  ): Promise<AdminManagedHiringOrderDetailDto> {
    this.assertLiveAnywhere();
    const notices: Notice[] = [];
    await this.guardTable(async () => {
      const order = await this.repo.getOrder(orderId);
      if (!order) throw new NotFoundException();
      await this.assertTrackable(workerId, order.jobPostingId);
      await this.repo.withTransaction(async (tx) => {
        const row = await this.repo.lockOrder(tx, orderId);
        if (!row) throw new NotFoundException();
        assertClockRunning(row);
        const added = await this.repo.insertInterestWithinTx(tx, {
          orderId,
          payerId: row.payerId,
          workerId,
          confirmedBy: adminId,
          note,
        });
        if (!added) {
          refused(ConflictException, "already_on_tracker", "This worker is already on the tracker");
        }
        const confirmed = await this.repo.countInterest(orderId, tx);
        const payload: PayloadInputOf<"managed_hiring.interest_added"> = {
          order_id: orderId,
          payer_id: row.payerId,
          worker_id: workerId,
          confirmed_count: confirmed,
        };
        await this.events.emit({
          event_name: "managed_hiring.interest_added",
          actor: { actor_type: "admin", actor_id: adminId },
          subject: { subject_type: "managed_hiring_order", subject_id: orderId },
          payload,
          idempotencyKey: `managed_hiring.interest_added:${added.id}`,
          correlationId: ctx.correlationId,
          ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
          tx,
        });
        await this.repo.audit(tx, {
          adminId,
          action: ADMIN_ACTION_CODES.managed_hiring_interest_added,
          orderId,
          metadata: { worker_id: workerId, confirmed_count: confirmed, note },
        });
        if (row.status === "extended" && confirmed >= row.targetCount) {
          const met = await this.endWithinTx(tx, row, "met", confirmed, "extension", {
            actor: { actor_type: "admin", actor_id: adminId },
            correlationId: ctx.correlationId,
            ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
          });
          notices.push({ order: met, kind: "met", confirmedCount: confirmed });
        }
      });
    });
    await this.sendNotices(notices);
    return this.getOrderForAdmin(orderId);
  }

  /** `DELETE /admin/managed-hiring/orders/:id/interest` — staff take a worker off the tracker. */
  async removeInterest(
    adminId: string,
    orderId: string,
    workerId: string,
    reason: string,
    ctx: RequestContext,
  ): Promise<AdminManagedHiringOrderDetailDto> {
    this.assertLiveAnywhere();
    await this.guardTable(() =>
      this.repo.withTransaction(async (tx) => {
        const row = await this.repo.lockOrder(tx, orderId);
        if (!row) throw new NotFoundException();
        assertClockRunning(row);
        const removed = await this.repo.deleteInterestWithinTx(tx, orderId, workerId);
        if (!removed) throw new NotFoundException();
        const confirmed = await this.repo.countInterest(orderId, tx);
        const payload: PayloadInputOf<"managed_hiring.interest_removed"> = {
          order_id: orderId,
          payer_id: row.payerId,
          worker_id: workerId,
          confirmed_count: confirmed,
        };
        await this.events.emit({
          event_name: "managed_hiring.interest_removed",
          actor: { actor_type: "admin", actor_id: adminId },
          subject: { subject_type: "managed_hiring_order", subject_id: orderId },
          payload,
          idempotencyKey: `managed_hiring.interest_removed:${removed.id}`,
          correlationId: ctx.correlationId,
          ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
          tx,
        });
        await this.repo.audit(tx, {
          adminId,
          action: ADMIN_ACTION_CODES.managed_hiring_interest_removed,
          orderId,
          metadata: { worker_id: workerId, confirmed_count: confirmed, reason_text: reason },
        });
      }),
    );
    return this.getOrderForAdmin(orderId);
  }

  async listCallbacksForAdmin(filter: {
    cursor?: string;
    limit: number;
  }): Promise<{ requests: CallbackRequestDto[]; next_cursor: string | null }> {
    this.assertLiveAnywhere();
    return this.guardTable(async () => {
      const rows = await this.repo.listCallbacks(
        decodeEntityCursor(filter.cursor),
        filter.limit + 1,
      );
      const page = rows.slice(0, filter.limit);
      const last = page.at(-1);
      return {
        requests: page.map((r) => ({
          request_id: r.id,
          payer_id: r.payerId,
          job_posting_id: r.jobPostingId,
          vacancy_band: r.vacancyBand,
          reason: r.reason,
          is_test: r.isTest,
          created_at: r.createdAt.toISOString(),
        })),
        next_cursor:
          rows.length > filter.limit && last
            ? encodeEntityCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
            : null,
      };
    });
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // The clock (the sweep, #2751 item 9)
  // ════════════════════════════════════════════════════════════════════════════════════════

  /**
   * Move every open order whose time is up, one per transaction, at most `limit` per tick:
   *  - `active` at its deadline: the target met → `met`; else → `extended` (free, to day 30);
   *  - `extended` at the extension's end: the target met → `met`; else → `closed_unmet`, and an
   *    admin is alerted (`managed_hiring.order_closed_unmet`; no automatic refund).
   * The company is told by email after each commit. Nothing while the switch is off everywhere; a
   * missing table is logged and waited out; one order's failure is logged and retried next tick.
   */
  async sweepDue(limit: number, now: Date = new Date()): Promise<ManagedHiringSweepResult> {
    if (!this.rollout.isLiveForServiceCaller("managed_hiring")) {
      return { skipped: true, due: 0, moved: 0, failed: 0 };
    }
    let ids: string[];
    try {
      ids = await this.repo.dueOrderIds(limit, now);
    } catch (err) {
      if (sqlStateOf(err) !== UNDEFINED_TABLE) throw err;
      this.logger.warn(
        `managed hiring sweep: managed_hiring_orders missing (sqlstate=${UNDEFINED_TABLE}); waiting for the migration`,
      );
      return { skipped: true, due: 0, moved: 0, failed: 0 };
    }
    let moved = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        const notice = await this.repo.withTransaction(async (tx) => {
          const row = await this.repo.lockOrder(tx, id);
          if (!row) return null;
          return this.advanceWithinTx(tx, row, now);
        });
        if (notice) {
          moved += 1;
          await this.sendNotices([notice]);
        }
      } catch (err) {
        failed += 1;
        this.logger.error(
          `managed hiring sweep: order=${id} failed (sqlstate=${sqlStateOf(err) ?? "none"}); retried next tick`,
        );
      }
    }
    return { skipped: false, due: ids.length, moved, failed };
  }

  /** One locked order whose time may be up. Null when it is not (re-checked under the lock). */
  private async advanceWithinTx(
    tx: Database,
    row: ManagedHiringOrderRow,
    now: Date,
  ): Promise<Notice | null> {
    const origin = {
      actor: { actor_type: "system" as const, actor_id: null },
      correlationId: `managed-hiring-sweep:${row.id}`,
    };
    const confirmed = await this.repo.countInterest(row.id, tx);
    if (row.status === "active" && row.dueAt !== null && row.dueAt.getTime() <= now.getTime()) {
      if (confirmed >= row.targetCount) {
        const met = await this.endWithinTx(tx, row, "met", confirmed, "deadline", origin);
        return { order: met, kind: "met", confirmedCount: confirmed };
      }
      const extended = await this.repo.moveWithinTx(tx, row.id, "active", "extended", now);
      if (!extended) return null;
      const payload: PayloadInputOf<"managed_hiring.order_extended"> = {
        order_id: row.id,
        payer_id: row.payerId,
        job_posting_id: row.jobPostingId,
        confirmed_count: confirmed,
        target_count: row.targetCount,
        extended_until: extended.extendedUntil!.toISOString(),
      };
      await this.events.emit({
        event_name: "managed_hiring.order_extended",
        ...origin,
        subject: { subject_type: "managed_hiring_order", subject_id: row.id },
        payload,
        idempotencyKey: `managed_hiring.order_extended:${row.id}`,
        tx,
      });
      return { order: extended, kind: "extended", confirmedCount: confirmed };
    }
    if (
      row.status === "extended" &&
      row.extendedUntil !== null &&
      row.extendedUntil.getTime() <= now.getTime()
    ) {
      if (confirmed >= row.targetCount) {
        const met = await this.endWithinTx(tx, row, "met", confirmed, "extension", origin);
        return { order: met, kind: "met", confirmedCount: confirmed };
      }
      const closed = await this.endWithinTx(tx, row, "closed_unmet", confirmed, null, origin);
      // The admin alert's loud half; the event is its record (and the dashboard's count).
      this.logger.warn(
        `managed hiring order closed NOT MET: an admin should follow up (no automatic refund) order=${row.id} confirmed=${confirmed}/${row.targetCount}`,
      );
      return { order: closed, kind: "closed_unmet", confirmedCount: confirmed };
    }
    return null;
  }

  /** End a locked open order as `met` or `closed_unmet`, with its event, on `tx`. */
  private async endWithinTx(
    tx: Database,
    row: ManagedHiringOrderRow,
    to: "met" | "closed_unmet",
    confirmed: number,
    metAt: "deadline" | "extension" | null,
    origin: {
      actor: { actor_type: "admin"; actor_id: string } | { actor_type: "system"; actor_id: null };
      correlationId: string;
      requestId?: string;
    },
  ): Promise<ManagedHiringOrderRow> {
    const ended = await this.repo.moveWithinTx(tx, row.id, row.status, to, new Date());
    if (!ended) refused(ConflictException, "order_changed", "The order changed; try again");
    const base = {
      ...origin,
      subject: { subject_type: "managed_hiring_order" as const, subject_id: row.id },
      tx,
    };
    if (to === "met") {
      const payload: PayloadInputOf<"managed_hiring.order_met"> = {
        order_id: row.id,
        payer_id: row.payerId,
        job_posting_id: row.jobPostingId,
        confirmed_count: confirmed,
        target_count: row.targetCount,
        met_at: metAt ?? "deadline",
      };
      await this.events.emit({
        event_name: "managed_hiring.order_met",
        ...base,
        payload,
        idempotencyKey: `managed_hiring.order_met:${row.id}`,
      });
    } else {
      const payload: PayloadInputOf<"managed_hiring.order_closed_unmet"> = {
        order_id: row.id,
        payer_id: row.payerId,
        job_posting_id: row.jobPostingId,
        confirmed_count: confirmed,
        target_count: row.targetCount,
      };
      await this.events.emit({
        event_name: "managed_hiring.order_closed_unmet",
        ...base,
        payload,
        idempotencyKey: `managed_hiring.order_closed_unmet:${row.id}`,
      });
    }
    return ended;
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // Activation (the settler, #2751 item 6)
  // ════════════════════════════════════════════════════════════════════════════════════════

  /**
   * Before the settle transaction: find the order the payment belongs to, and read the holiday list
   * the clock skips (the catalogue's `managed_hiring.holidays`, empty by the owner's ruling). A
   * failure throws: nothing is claimed and the webhook retries.
   */
  private async prepareActivation(payment: PaymentOrder): Promise<ActivationPlan> {
    const order = await this.repo.findOrderByPaymentOrder(payment.id);
    if (!order) {
      throw new Error(`no managed hiring order for payment order ${payment.id}`);
    }
    const active = await this.pricing.getActiveCatalog();
    return { orderId: order.id, holidays: holidaysOf(active.catalog) };
  }

  /**
   * On the settle transaction, right after the payment order was claimed `paid` (exactly once):
   * `created` → `active`, the clock stamped from NOW (the capture), `managed_hiring.order_activated`
   * on the same transaction. An order no longer `created` is left alone.
   */
  private async activateWithinTx(
    tx: SettleTx,
    payment: PaymentOrder,
    plan: ActivationPlan,
    ctx: SettleContext,
  ): Promise<void> {
    const db = tx as unknown as Database;
    const row = await this.repo.lockOrder(db, plan.orderId);
    if (!row || row.paymentOrderId !== payment.id) {
      throw new Error(`managed hiring order ${plan.orderId} does not match payment ${payment.id}`);
    }
    if (row.status !== "created") return;
    const startedAt = new Date();
    const clock = managedHiringClock({
      capturedAt: startedAt,
      workingDays: row.workingDays,
      extensionDays: row.extensionDays,
      holidays: plan.holidays,
    });
    const active = await this.repo.activateWithinTx(db, row.id, {
      startedAt,
      dueAt: clock.dueAt,
      extendedUntil: clock.extensionEndsAt,
    });
    if (!active) return;
    const payload: PayloadInputOf<"managed_hiring.order_activated"> = {
      order_id: row.id,
      payer_id: row.payerId,
      job_posting_id: row.jobPostingId,
      payment_order_id: payment.id,
      target_count: row.targetCount,
      started_at: startedAt.toISOString(),
      due_at: clock.dueAt.toISOString(),
      extended_until: clock.extensionEndsAt.toISOString(),
    };
    await this.events.emit({
      event_name: "managed_hiring.order_activated",
      actor: { actor_type: "system", actor_id: null },
      subject: { subject_type: "managed_hiring_order", subject_id: row.id },
      payload,
      idempotencyKey: `managed_hiring.order_activated:${row.id}`,
      correlationId: ctx.correlationId,
      ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
      tx: db,
    });
  }

  private async notifyActivated(payment: PaymentOrder): Promise<void> {
    const order = await this.repo.findOrderByPaymentOrder(payment.id);
    if (!order || order.status !== "active") return;
    await this.sendNotices([{ order, kind: "activated", confirmedCount: 0 }]);
  }

  // ════════════════════════════════════════════════════════════════════════════════════════
  // Shared
  // ════════════════════════════════════════════════════════════════════════════════════════

  /**
   * The route gate on its own: the neutral 404 (or 503 for an unreadable pilot list) BEFORE a route
   * looks at its body or `Idempotency-Key`, so a switched-off route is indistinguishable from one
   * that does not exist, and no refusal is pinned under a key.
   */
  async assertOpenFor(actorPayerId: string): Promise<void> {
    await this.liveScope(actorPayerId);
  }

  /** The caller's scope when the switch is on for its company AND money is real; else 404. */
  private async liveScope(actorPayerId: string): Promise<PayerTenantScope> {
    const scope = await this.tenancy.resolve(actorPayerId);
    const state = await this.rollout.stateFor("managed_hiring", scope.tenantKey);
    if (state === "unavailable") throw new ServiceUnavailableException();
    if (state !== "on") throw new NotFoundException();
    // On the mock path a purchase takes no money: the product is not offered at all.
    if (!this.checkout.realPaymentsLive) throw new NotFoundException();
    return scope;
  }

  /** The admin routes and the sweep: the switch is on for at least one company. */
  private assertLiveAnywhere(): void {
    if (!this.rollout.isLiveForServiceCaller("managed_hiring")) throw new NotFoundException();
  }

  /** Agency and contractor accounts (`agent`) cannot buy it (B4C-19, B2-50): a 403. */
  private async assertEmployer(tenant: TenantKey): Promise<{ isTest: boolean }> {
    const facts = await this.repo.companyFacts(tenant);
    if (!facts) throw new NotFoundException();
    if (facts.role !== "employer") {
      refused(
        ForbiddenException,
        "agency_account",
        "Managed Hiring is for companies hiring for themselves; agency accounts cannot buy it",
      );
    }
    return { isTest: facts.isTest };
  }

  /** The company's own posting, live (open, not hidden by an admin); else 404 / 409. */
  private async ownOpenJob(tenant: TenantKey, jobPostingId: string): Promise<ManagedHiringJobRow> {
    const job = await this.repo.findOwnJob(tenant, jobPostingId);
    if (!job) throw new NotFoundException();
    if (job.status !== "open" || job.hiddenAt !== null) {
      refused(
        ConflictException,
        "job_not_open",
        "Managed Hiring needs a live job; publish it first",
      );
    }
    return job;
  }

  /**
   * The tier's list price and terms from the LIVE catalogue, and its GST line (`gstPriceLine`, the
   * one GST function). A stored catalogue that fails validation sells nothing (503), exactly as
   * the credit packs; a tier the catalogue does not list is a 503 too (never an invented price).
   */
  private async priceTier(
    tier: ManagedHiringTier,
  ): Promise<{ tier: CatalogTier; line: GstPriceLine }> {
    const active = await this.pricing.getActiveCatalog();
    if (isRejectedCatalogRow(active)) {
      this.logger.error("managed hiring refused: the stored pricing catalogue is rejected");
      throw new ServiceUnavailableException();
    }
    const product = active.catalog.products.find(
      (p) => p.kind === "managed_hiring" && p.code === MANAGED_HIRING_PRODUCT,
    );
    const found =
      product?.kind === "managed_hiring" ? product.tiers.find((t) => t.code === tier) : undefined;
    if (!found) {
      this.logger.error(`managed hiring refused: the catalogue has no tier=${tier}`);
      throw new ServiceUnavailableException();
    }
    return { tier: found, line: gstPriceLine(found.priceInr) };
  }

  /** The job's open order handed back: an unpaid one of the same tier re-hands its checkout. */
  private handBack(
    open: ManagedHiringOrderRow,
    tier: ManagedHiringTier,
  ): Promise<ManagedHiringCheckoutDto> {
    if (open.status !== "created" || open.tier !== tier) {
      refused(
        ConflictException,
        "order_open",
        "This job already has a Managed Hiring order; it can be bought again once it ends",
      );
    }
    return this.checkout.findOrderById(open.paymentOrderId).then((payment) => {
      const handoff = payment ? this.checkout.handoffFor(payment) : null;
      if (!payment || !isPayable(payment) || handoff === null) {
        refused(
          ConflictException,
          "order_open",
          "This job already has a Managed Hiring order waiting for its payment",
        );
      }
      return checkoutDto(open.id, handoff);
    });
  }

  private async insertOrderWithinTx(
    tx: Database,
    input: {
      scope: PayerTenantScope;
      jobPostingId: string;
      tier: ManagedHiringTier;
      paymentOrder: PaymentOrder;
      priced: { tier: CatalogTier; line: GstPriceLine };
      isTest: boolean;
      ctx: RequestContext;
    },
  ): Promise<ManagedHiringOrderRow> {
    const { tier: terms, line } = input.priced;
    const row = await this.repo.insertOrderWithinTx(tx, {
      payerId: input.scope.tenantKey,
      createdBy: input.scope.actorPayerId,
      jobPostingId: input.jobPostingId,
      tier: input.tier,
      paymentOrderId: input.paymentOrder.id,
      priceInr: terms.priceInr,
      targetCount: terms.targetCount,
      workingDays: terms.workingDays,
      extensionDays: terms.extensionDays,
      isTest: input.isTest,
    });
    if (!row) {
      // A racing checkout for the same job won: roll this one back (its payment row with it).
      refused(
        ConflictException,
        "order_open",
        "This job already has a Managed Hiring order; it can be bought again once it ends",
      );
    }
    const payload: PayloadInputOf<"managed_hiring.order_created"> = {
      order_id: row.id,
      payer_id: input.scope.tenantKey,
      job_posting_id: input.jobPostingId,
      payment_order_id: input.paymentOrder.id,
      tier: input.tier,
      price_inr: terms.priceInr,
      total_paise: line.totalPaise,
    };
    await this.events.emit({
      event_name: "managed_hiring.order_created",
      actor: { actor_type: "payer", actor_id: input.scope.actorPayerId },
      subject: { subject_type: "managed_hiring_order", subject_id: row.id },
      payload,
      idempotencyKey: `managed_hiring.order_created:${row.id}`,
      correlationId: input.ctx.correlationId,
      ...(input.ctx.requestId ? { requestId: input.ctx.requestId } : {}),
      tx,
    });
    return row;
  }

  /** Who may go on a tracker (see {@link addInterest}). */
  private async assertTrackable(workerId: string, jobPostingId: string): Promise<void> {
    if (!(await this.repo.isWorkerReachable(workerId))) {
      refused(ConflictException, "worker_unavailable", "This worker cannot be added");
    }
    if (!(await hasActiveConsent(this.consents, workerId, "employer_sharing"))) {
      refused(
        ConflictException,
        "no_sharing_consent",
        "This worker has not agreed to share his details with companies",
      );
    }
    if (
      (await this.repo.isRvmStudent(workerId)) &&
      !(await this.repo.hasAppliedTo(workerId, jobPostingId))
    ) {
      refused(
        ConflictException,
        "rvm_student_not_applied",
        "An RVM student can be added only if he applied to this job",
      );
    }
  }

  private async payerOrderDto(order: OrderWithCount): Promise<PayerManagedHiringOrderDto> {
    const workers: ManagedHiringInterestRow[] =
      order.status === "created" ? [] : await this.repo.listInterest(order.id);
    let checkout: ManagedHiringCheckoutDto | null = null;
    if (order.status === "created") {
      const payment = await this.checkout.findOrderById(order.paymentOrderId);
      const handoff = payment && isPayable(payment) ? this.checkout.handoffFor(payment) : null;
      checkout = handoff ? checkoutDto(order.id, handoff) : null;
    }
    return {
      order_id: order.id,
      job_posting_id: order.jobPostingId,
      tier: order.tier,
      status: order.status,
      price_inr: order.priceInr,
      target_count: order.targetCount,
      confirmed_count: order.confirmedCount,
      started_at: iso(order.startedAt),
      due_at: iso(order.dueAt),
      extended_until: iso(order.extendedUntil),
      ended_at: iso(order.endedAt),
      terms: MANAGED_HIRING_TERMS,
      checkout,
      workers: workers.map((w) => ({
        worker_id: w.workerId,
        confirmed_at: w.confirmedAt.toISOString(),
      })),
    };
  }

  private async sendNotices(notices: readonly Notice[]): Promise<void> {
    for (const n of notices) {
      await this.mailer.notify(n.order.createdBy, n.order.id, {
        kind: n.kind,
        confirmedCount: n.confirmedCount,
        targetCount: n.order.targetCount,
        until:
          n.kind === "activated"
            ? n.order.dueAt
            : n.kind === "extended"
              ? n.order.extendedUntil
              : null,
      });
    }
  }

  private async guardTable<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (sqlStateOf(err) === UNDEFINED_TABLE) {
        this.logger.error(
          `managed_hiring tables missing (sqlstate=${UNDEFINED_TABLE}); apply the managed_hiring migration`,
        );
        throw new ServiceUnavailableException();
      }
      throw err;
    }
  }
}

/**
 * Can this payment order still be paid? `created`, or `failed` (a failed attempt: Razorpay accepts
 * another payment on the same order, and the settle path still captures a `failed` order). A `paid`
 * or `held` one cannot.
 */
function isPayable(payment: PaymentOrder): boolean {
  return payment.status === "created" || payment.status === "failed";
}

function assertClockRunning(row: ManagedHiringOrderRow): void {
  if (!(MANAGED_HIRING_OPEN_STATUSES as readonly string[]).includes(row.status)) {
    refused(
      ConflictException,
      "order_not_open",
      "The order's clock is not running; its tracker is closed",
    );
  }
}

/** The catalogue's Managed Hiring holiday list (empty when the product or the list is absent). */
export function holidaysOf(catalog: Catalog): readonly string[] {
  const product = catalog.products.find(
    (p) => p.kind === "managed_hiring" && p.code === MANAGED_HIRING_PRODUCT,
  );
  return product?.kind === "managed_hiring" ? (product.holidays ?? []) : [];
}

function priceDto(priceInr: number, line: GstPriceLine): ManagedHiringPriceDto {
  return {
    price_inr: priceInr,
    taxable_paise: line.taxablePaise,
    gst_paise: line.gstPaise,
    round_off_paise: line.roundOffPaise,
    total_paise: line.totalPaise,
    gst_rate_bps: line.gstRateBps,
  };
}

function checkoutDto(orderId: string, h: RealProductOrderHandoff): ManagedHiringCheckoutDto {
  return {
    order_id: orderId,
    provider_order_id: h.providerOrderId,
    key_id: h.keyId,
    amount: h.amountPaise,
    amount_inr: h.amountInr,
    currency: h.currency,
    price: {
      taxable_paise: h.price.taxablePaise,
      gst_paise: h.price.gstPaise,
      round_off_paise: h.price.roundOffPaise,
      total_paise: h.price.totalPaise,
      gst_rate_bps: h.price.gstRateBps,
    },
  };
}

function iso(at: Date | null): string | null {
  return at ? at.toISOString() : null;
}

function adminOrderDto(o: OrderWithCount): AdminManagedHiringOrderDto {
  return {
    order_id: o.id,
    payer_id: o.payerId,
    job_posting_id: o.jobPostingId,
    tier: o.tier,
    status: o.status,
    price_inr: o.priceInr,
    target_count: o.targetCount,
    confirmed_count: o.confirmedCount,
    started_at: iso(o.startedAt),
    due_at: iso(o.dueAt),
    extended_until: iso(o.extendedUntil),
    ended_at: iso(o.endedAt),
    is_test: o.isTest,
    created_at: o.createdAt.toISOString(),
  };
}

function adminWorkerDto(w: ManagedHiringInterestRow): AdminTrackerWorkerDto {
  return {
    worker_id: w.workerId,
    confirmed_at: w.confirmedAt.toISOString(),
    confirmed_by: w.confirmedBy,
    note: w.note,
  };
}
