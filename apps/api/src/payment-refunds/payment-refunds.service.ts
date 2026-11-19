import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type {
  Database,
  PaymentOrder,
  PaymentRefundFailure,
  PaymentRefundRow,
  PaymentRefundRule,
  PaymentRefundStatus,
} from "@badabhai/db";
import type { CreditRules } from "@badabhai/pricing";
import { ADMIN_ACTION_CODES } from "../admin/admin-action-codes";
import { sqlStateOf } from "../common/db-error";
import type { RequestContext } from "../common/request-context";
import { CreditRulesService } from "../credit-rules/credit-rules.service";
import { EventsService } from "../events/events.service";
import { RazorpayClient, type ProviderRefund } from "../unlocks/razorpay.client";
import { CREDIT_NOTE_ISSUER, type CreditNoteIssuer } from "./credit-note-issuer";
import type { RefundPaymentDto } from "./payment-refunds.dto";
import { PaymentRefundsRepository, type OrderPackLot } from "./payment-refunds.repository";

const UNDEFINED_TABLE = "42P01";
const DAY_MS = 24 * 60 * 60 * 1000;
/** A refund still `requested` this long after it was written lost its provider call (a crash). */
const STALE_REQUESTED_MS = 10 * 60 * 1000;

/** What one rule says about one order today. */
export interface RefundRuleCheck {
  readonly eligible: boolean;
  /** The last instant the rule's window allows a refund. */
  readonly until: string;
  /** Why not, as a closed code (null when eligible). */
  readonly refusal: RefundRefusal | null;
}

export type RefundRefusal =
  | "pack_used"
  | "window_passed"
  | "no_job"
  | "too_many_applicants";

/** The low-match rule adds the job it counted and the count. */
export interface LowMatchCheck extends RefundRuleCheck {
  readonly job_posting_id: string | null;
  readonly applicants: number | null;
  /** The rule holds when `applicants` is below this. */
  readonly needs_fewer_than: number;
}

/** One refund, as the admin console reads it. Ids, codes, integers and times. */
export interface RefundView {
  readonly id: string;
  readonly payment_order_id: string;
  readonly payer_id: string;
  readonly rule: PaymentRefundRule;
  readonly job_posting_id: string | null;
  readonly applicants_counted: number | null;
  readonly requested_by: string;
  readonly amount_paise: number;
  readonly credits_removed: number;
  readonly status: PaymentRefundStatus;
  readonly failure_code: PaymentRefundFailure | null;
  readonly provider_refund_id: string | null;
  readonly credit_note_number: string | null;
  readonly requested_at: string;
  readonly processed_at: string | null;
}

/** `GET /admin/payment-orders/:id/refund-eligibility`. */
export interface RefundEligibilityView {
  readonly payment_order_id: string;
  readonly payer_id: string;
  readonly amount_paise: number;
  readonly credits: number;
  readonly purchased_at: string;
  readonly pack_unused: boolean;
  readonly refund: RefundView | null;
  readonly rules: { readonly unused: RefundRuleCheck; readonly low_match: LowMatchCheck };
}

/** The facts a refund decision reads, gathered once (inside the transaction for a refund). */
interface RefundFacts {
  readonly order: PaymentOrder;
  readonly lot: OrderPackLot;
  readonly jobPostingId: string | null;
  readonly applicants: number | null;
}

/** The order's whole total in paise: `total_paise`, or `amount_inr` × 100 on a pre-0176 row. */
export function orderTotalPaise(order: Pick<PaymentOrder, "totalPaise" | "amountInr">): number {
  return order.totalPaise ?? order.amountInr * 100;
}

/**
 * The two refund rules on one order's facts (brief 4C.12, B4C-26, B4C-27). PURE. Both need the pack
 * unused: nothing spent from its lot and the lot not expired. Windows count from the settle (the
 * lot's creation), inclusive of the last day's instant.
 */
export function checkRefundRules(
  facts: { lot: OrderPackLot; jobPostingId: string | null; applicants: number | null },
  rules: Pick<
    CreditRules,
    "refundUnusedWithinDays" | "refundLowMatchWithinDays" | "refundLowMatchMinWorkers"
  >,
  now: Date,
): { unused: RefundRuleCheck; low_match: LowMatchCheck } {
  const unusedPack =
    facts.lot.expiredAt === null && facts.lot.creditsRemaining === facts.lot.creditsGranted;
  const bought = facts.lot.createdAt.getTime();
  const window = (days: number) => {
    const until = new Date(bought + days * DAY_MS);
    return { until: until.toISOString(), open: now.getTime() <= until.getTime() };
  };

  const u = window(rules.refundUnusedWithinDays);
  const unusedRefusal: RefundRefusal | null = !unusedPack
    ? "pack_used"
    : !u.open
      ? "window_passed"
      : null;

  const l = window(rules.refundLowMatchWithinDays);
  const lowMatchRefusal: RefundRefusal | null = !unusedPack
    ? "pack_used"
    : !l.open
      ? "window_passed"
      : facts.jobPostingId === null || facts.applicants === null
        ? "no_job"
        : facts.applicants >= rules.refundLowMatchMinWorkers
          ? "too_many_applicants"
          : null;

  return {
    unused: { eligible: unusedRefusal === null, until: u.until, refusal: unusedRefusal },
    low_match: {
      eligible: lowMatchRefusal === null,
      until: l.until,
      refusal: lowMatchRefusal,
      job_posting_id: facts.jobPostingId,
      applicants: facts.applicants,
      needs_fewer_than: rules.refundLowMatchMinWorkers,
    },
  };
}

/** A refund status as Razorpay names it, mapped to ours. Anything unknown is still `pending`. */
export function statusFromProvider(refund: Pick<ProviderRefund, "status">): {
  status: "pending" | "processed" | "failed";
  failureCode: PaymentRefundFailure | null;
} {
  if (refund.status === "processed") return { status: "processed", failureCode: null };
  if (refund.status === "failed") return { status: "failed", failureCode: "provider_failed" };
  return { status: "pending", failureCode: null };
}

/** The statuses a provider answer may move a refund out of, per target. Processed is final. */
const MOVABLE_FROM: Record<"pending" | "processed" | "failed", readonly PaymentRefundStatus[]> = {
  pending: ["requested", "failed"],
  processed: ["requested", "pending", "failed"],
  failed: ["requested", "pending"],
};

/**
 * #2750 item 10 — admin refunds of real paid packs (brief 4C.12).
 *
 * A super admin refunds one real Razorpay pack order IN FULL under one of two rules (owner rulings
 * 2026-11-18): the pack is unused within `refundUnusedWithinDays` (7) of its purchase; or unused
 * within `refundLowMatchWithinDays` (30) and its job drew fewer than `refundLowMatchMinWorkers` (3)
 * applicants. Any real paid order qualifies, pilot company or not.
 *
 * ORDER OF OPERATIONS — credits first, money second. One transaction locks the order, checks the
 * rule, takes the pack's credits back (and any credits that came back with it, #2750 item 9) with
 * `pack_refund` lines, writes the refund row, the audit row and `payment.refund_requested`. Only
 * then is Razorpay asked to refund, so a company can never spend credits whose money is on its way
 * back. A provider failure leaves the credits removed and the row `failed`; an admin retries it
 * (a retry first looks the refund up at Razorpay by our row id, so a lost answer is never paid
 * twice). Razorpay's refund webhooks move the row to `processed` or `failed`.
 *
 * NO REFUND WITHOUT ITS CREDIT NOTE (owner ruling 2026-11-18). The GST credit note is numbered and
 * written in the refund's own transaction (#2749 part 4, `InvoiceCreditNotes`); an order with no
 * invoice, or whose invoice total is not the refund amount, is refused before any write (409
 * `NO_INVOICE_FOR_ORDER` / `CREDIT_NOTE_AMOUNT_MISMATCH`), and with no active seller row the
 * refund answers 503 `INVOICES_UNAVAILABLE`. A failed refund keeps its credit note (the credits
 * stay removed; an admin retries). An issuer that is not available (`NoCreditNotes`, tests only)
 * makes every route answer 503 `CREDIT_NOTES_UNAVAILABLE` before any read.
 */
@Injectable()
export class PaymentRefundsService {
  private readonly logger = new Logger(PaymentRefundsService.name);

  constructor(
    private readonly repo: PaymentRefundsRepository,
    private readonly creditRules: CreditRulesService,
    private readonly razorpay: RazorpayClient,
    private readonly events: EventsService,
    @Inject(CREDIT_NOTE_ISSUER) private readonly creditNotes: CreditNoteIssuer,
  ) {}

  /** What each rule says about this order today, and any refund already made. */
  async eligibility(orderId: string, jobPostingId?: string): Promise<RefundEligibilityView> {
    this.assertOn();
    return this.guardTable(async () => {
      const order = await this.repo.getOrder(orderId);
      if (!order || !isRefundableOrder(order)) throw new NotFoundException();
      const facts = await this.facts(this.repo.reader, order, jobPostingId);
      const rules = await this.creditRules.get();
      const existing = await this.repo.findByOrder(this.repo.reader, orderId);
      return {
        payment_order_id: order.id,
        payer_id: order.payerId,
        amount_paise: orderTotalPaise(order),
        credits: order.creditsGranted,
        purchased_at: facts.lot.createdAt.toISOString(),
        pack_unused:
          facts.lot.expiredAt === null && facts.lot.creditsRemaining === facts.lot.creditsGranted,
        refund: existing ? toView(existing) : null,
        rules: checkRefundRules(facts, rules, new Date()),
      };
    });
  }

  /**
   * Refund one order under `dto.rule`. Refusals, before anything is written:
   *  - 404: no such order, or not a real paid credit-pack order;
   *  - 409 `ALREADY_REFUNDED`: the order has a refund (one per order, ever);
   *  - 409 `REFUND_RULE_NOT_MET` with `rule` and `refusal` (`pack_used`, `window_passed`, `no_job`,
   *    `too_many_applicants`);
   *  - 409 `NO_INVOICE_FOR_ORDER` / `CREDIT_NOTE_AMOUNT_MISMATCH`, 503 `INVOICES_UNAVAILABLE`: no
   *    credit note can be issued (#2749 part 4);
   *  - 404: a `job_posting_id` that is not the company's own.
   */
  async refund(
    adminId: string,
    orderId: string,
    dto: RefundPaymentDto,
    ctx: RequestContext,
  ): Promise<RefundView> {
    this.assertOn();
    const rules = await this.creditRules.get();
    const written = await this.guardTable(() =>
      this.repo.withTransaction(async (tx) => {
        const order = await this.repo.lockOrder(tx, orderId);
        if (!order || !isRefundableOrder(order)) throw new NotFoundException();
        if (await this.repo.findByOrder(tx, orderId)) {
          throw new ConflictException({
            code: "ALREADY_REFUNDED",
            message: "this order has already been refunded",
          });
        }
        const facts = await this.facts(
          tx,
          order,
          dto.rule === "low_match" ? dto.job_posting_id : undefined,
          dto.rule === "low_match",
        );
        const check = checkRefundRules(facts, rules, new Date())[dto.rule];
        if (!check.eligible) {
          throw new ConflictException({
            code: "REFUND_RULE_NOT_MET",
            message: `the ${dto.rule} refund rule does not hold for this order`,
            rule: dto.rule,
            refusal: check.refusal,
          });
        }

        // #2749 part 4 — the credit note, step 1, BEFORE any write: the order's invoice, refused
        // with a typed code when it has none or its total is not the refund amount.
        const creditNote = await this.creditNotes.prepare(tx, order, orderTotalPaise(order));

        // Credits first: the pack, then whatever came back with it (#2750 item 9).
        let creditsRemoved = await this.repo.removeLot(tx, order.payerId, facts.lot.id);
        for (const lotId of await this.repo.returnedLotIds(
          tx,
          order.payerId,
          order.providerPaymentRef!,
        )) {
          creditsRemoved += await this.repo.removeLot(tx, order.payerId, lotId);
        }

        const inserted = await this.repo.insertRefund(tx, {
          paymentOrderId: order.id,
          payerId: order.payerId,
          rule: dto.rule,
          jobPostingId: dto.rule === "low_match" ? facts.jobPostingId : null,
          applicantsCounted: dto.rule === "low_match" ? facts.applicants : null,
          requestedBy: adminId,
          amountPaise: orderTotalPaise(order),
          creditsRemoved,
        });
        // #2749 part 4 — the credit note, step 2, on this same transaction: numbered, written, its
        // number stamped on the refund row, `credit_note.issued` recorded.
        const issued = await this.creditNotes.issueWithinTx(tx, creditNote, inserted, ctx);
        const row: PaymentRefundRow = { ...inserted, creditNoteNumber: issued.creditNoteNumber };
        await this.repo.audit(tx, {
          adminId,
          action: ADMIN_ACTION_CODES.payment_refund_requested,
          refundId: row.id,
          metadata: {
            payment_order_id: order.id,
            payer_id: order.payerId,
            rule: dto.rule,
            amount_paise: row.amountPaise,
            credits_removed: creditsRemoved,
            job_posting_id: row.jobPostingId,
            applicants_counted: row.applicantsCounted,
            reason_text: dto.reason_text,
            credit_note_number: issued.creditNoteNumber,
          },
        });
        await this.events.emit({
          event_name: "payment.refund_requested",
          actor: { actor_type: "admin", actor_id: adminId },
          subject: { subject_type: "payer", subject_id: order.payerId },
          payload: {
            refund_id: row.id,
            payment_order_id: order.id,
            payer_id: order.payerId,
            rule: dto.rule,
            amount_paise: row.amountPaise,
            credits_removed: creditsRemoved,
          },
          idempotencyKey: `payment.refund_requested:${row.id}`,
          correlationId: ctx.correlationId,
          ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
          tx,
        });
        return { row, paymentRef: order.providerPaymentRef! };
      }),
    );
    return this.submit(written.row, written.paymentRef, ctx);
  }

  /** One refund. */
  async get(refundId: string): Promise<RefundView> {
    this.assertOn();
    const row = await this.guardTable(() => this.repo.getRefund(refundId));
    if (!row) throw new NotFoundException();
    return toView(row);
  }

  /**
   * Send a refund to Razorpay again: a `failed` one, or a `requested` one whose provider call was
   * lost (older than ten minutes). 409 `REFUND_NOT_RETRYABLE` otherwise. The credits stay removed.
   */
  async retry(
    adminId: string,
    refundId: string,
    reasonText: string,
    ctx: RequestContext,
  ): Promise<RefundView> {
    this.assertOn();
    const found = await this.guardTable(async () => {
      const row = await this.repo.getRefund(refundId);
      if (!row) throw new NotFoundException();
      const order = await this.repo.getOrder(row.paymentOrderId);
      return { row, order };
    });
    const { row, order } = found;
    const stale = Date.now() - row.requestedAt.getTime() > STALE_REQUESTED_MS;
    if (!(row.status === "failed" || (row.status === "requested" && stale)) || !order) {
      throw new ConflictException({
        code: "REFUND_NOT_RETRYABLE",
        message: `a ${row.status} refund is not sent again`,
      });
    }
    await this.repo.withTransaction((tx) =>
      this.repo.audit(tx, {
        adminId,
        action: ADMIN_ACTION_CODES.payment_refund_retried,
        refundId,
        metadata: { payment_order_id: row.paymentOrderId, status: row.status, reason_text: reasonText },
      }),
    );
    return this.submit(row, order.providerPaymentRef!, ctx);
  }

  /**
   * Razorpay's refund webhooks (`refund.processed`, `refund.failed`, `refund.created`). The refund
   * is found by its provider id, else by the row id we put in its notes (a refund whose answer we
   * lost). A refund this code did not make (one from the dashboard) is acknowledged and ignored.
   * Never throws for a missing table: it logs and acknowledges, so Razorpay does not retry forever.
   */
  async handleProviderRefundEvent(event: {
    eventName: string;
    refundId: string | null;
    status: string | null;
    notesRefundRowId: string | null;
  }): Promise<"updated" | "no_op"> {
    const target =
      event.eventName === "refund.processed"
        ? ({ status: "processed" } as const)
        : event.eventName === "refund.failed"
          ? ({ status: "failed" } as const)
          : event.eventName === "refund.created"
            ? ({ status: "pending" } as const)
            : null;
    if (target === null || event.refundId === null) return "no_op";
    // Until credit notes exist this code has made no refund, so a refund delivery is one made in
    // the Razorpay dashboard (a held order, #2749): acknowledged without reading the table.
    if (!this.creditNotes.available) return "no_op";
    try {
      let row = await this.repo.findByProviderRefundId(event.refundId);
      if (!row && event.notesRefundRowId !== null && isUuid(event.notesRefundRowId)) {
        row = await this.repo.getRefund(event.notesRefundRowId);
      }
      if (!row) return "no_op";
      const moved = await this.move(row, target.status, {
        providerRefundId: event.refundId,
        failureCode: target.status === "failed" ? "provider_failed" : null,
      }, { correlationId: `razorpay-refund:${event.refundId}` });
      return moved ? "updated" : "no_op";
    } catch (err) {
      if (sqlStateOf(err) === UNDEFINED_TABLE) {
        this.logger.error("refund webhook: payment_refunds is missing (migration not applied)");
        return "no_op";
      }
      throw err;
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────

  /**
   * Ask Razorpay to refund. A refund it already made for this row (found by our id in its notes)
   * is adopted, never made twice. Never throws: a provider error marks the row `failed`.
   */
  private async submit(
    row: PaymentRefundRow,
    paymentRef: string,
    ctx: RequestContext,
  ): Promise<RefundView> {
    let provider: ProviderRefund;
    try {
      provider =
        (await this.razorpay.findRefundForRow(paymentRef, row.id)) ??
        (await this.razorpay.refundPayment({
          paymentId: paymentRef,
          amountPaise: row.amountPaise,
          refundRowId: row.id,
        }));
    } catch {
      // The client logged the error class. The credits stay removed; an admin retries.
      const failed = await this.move(row, "failed", { failureCode: "provider_error" }, ctx);
      return toView(failed ?? row);
    }
    const next = statusFromProvider(provider);
    const moved = await this.move(
      row,
      next.status,
      { providerRefundId: provider.id, failureCode: next.failureCode },
      ctx,
    );
    return toView(moved ?? (await this.repo.getRefund(row.id)) ?? row);
  }

  /**
   * Move a refund to `to` and record `payment.refund_status_changed` on the same transaction. A
   * move the row's current status does not allow (processed is final; a concurrent webhook moved it
   * first) writes nothing and returns undefined.
   */
  private async move(
    row: PaymentRefundRow,
    to: "pending" | "processed" | "failed",
    patch: { providerRefundId?: string; failureCode?: PaymentRefundFailure | null },
    ctx: { correlationId: string; requestId?: string },
  ): Promise<PaymentRefundRow | undefined> {
    return this.repo.withTransaction(async (tx) => {
      const moved = await this.repo.transition(tx, row.id, MOVABLE_FROM[to], to, patch);
      if (!moved) return undefined;
      await this.events.emit({
        event_name: "payment.refund_status_changed",
        actor: { actor_type: "system", actor_id: null },
        subject: { subject_type: "payer", subject_id: moved.payerId },
        payload: {
          refund_id: moved.id,
          payment_order_id: moved.paymentOrderId,
          payer_id: moved.payerId,
          status: to,
          failure_code: to === "failed" ? (moved.failureCode ?? "provider_error") : null,
        },
        // One per refund and status; a failure retried and failed again is one more, per attempt.
        idempotencyKey:
          to === "failed"
            ? `payment.refund_status_changed:${moved.id}:failed:${moved.updatedAt.toISOString()}`
            : `payment.refund_status_changed:${moved.id}:${to}`,
        correlationId: ctx.correlationId,
        ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
        tx,
      });
      return moved;
    });
  }

  /** The order's pack lot and, for rule 2, the job counted and its applicants. */
  private async facts(
    db: Database,
    order: PaymentOrder,
    jobPostingId: string | undefined,
    requireOwnedJob = false,
  ): Promise<RefundFacts> {
    const lot = await this.repo.findPackLot(db, order.id);
    if (!lot) throw new NotFoundException();
    const jobId = jobPostingId ?? order.originJobPostingId ?? null;
    if (jobId === null) return { order, lot, jobPostingId: null, applicants: null };
    if (!(await this.repo.postingOwnedBy(db, jobId, order.payerId))) {
      // A job named by the admin that is not the company's: the same neutral 404.
      if (jobPostingId !== undefined || requireOwnedJob) throw new NotFoundException();
      return { order, lot, jobPostingId: null, applicants: null };
    }
    return { order, lot, jobPostingId: jobId, applicants: await this.repo.countApplicants(db, jobId) };
  }

  private assertOn(): void {
    if (!this.creditNotes.available) {
      throw new ServiceUnavailableException({
        code: "CREDIT_NOTES_UNAVAILABLE",
        message: "refunds are off until GST credit notes can be issued",
      });
    }
    if (!this.razorpay.isLive) {
      throw new ServiceUnavailableException({
        code: "REAL_PAYMENTS_OFF",
        message: "real payments are not enabled",
      });
    }
  }

  private async guardTable<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (sqlStateOf(err) === UNDEFINED_TABLE) {
        this.logger.error("payment_refunds is missing (migration not applied)");
        throw new ServiceUnavailableException("refunds are not available yet");
      }
      throw err;
    }
  }
}

/** A real, paid, credit-pack order with a provider payment to refund. */
function isRefundableOrder(order: PaymentOrder): boolean {
  return (
    order.status === "paid" &&
    order.productKind === "credit_pack" &&
    order.providerPaymentRef !== null &&
    order.providerPaymentRef.length > 0
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function toView(row: PaymentRefundRow): RefundView {
  return {
    id: row.id,
    payment_order_id: row.paymentOrderId,
    payer_id: row.payerId,
    rule: row.rule,
    job_posting_id: row.jobPostingId,
    applicants_counted: row.applicantsCounted,
    requested_by: row.requestedBy,
    amount_paise: row.amountPaise,
    credits_removed: row.creditsRemoved,
    status: row.status,
    failure_code: row.failureCode,
    provider_refund_id: row.providerRefundId,
    credit_note_number: row.creditNoteNumber,
    requested_at: row.requestedAt.toISOString(),
    processed_at: row.processedAt ? row.processedAt.toISOString() : null,
  };
}
