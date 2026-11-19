import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { RequestIdempotency } from "../common/idempotency/request-idempotency.service";
import { inFlightConflict } from "../common/idempotency/in-flight-conflict";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { Ctx, type RequestContext } from "../common/request-context";
import { CurrentPayer, PayerAuthGuard, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import {
  CreateManagedHiringOrderSchema,
  ManagedHiringCallbackSchema,
  ManagedHiringOrdersQuerySchema,
  ManagedHiringQuoteQuerySchema,
  managedHiringOrderFingerprint,
  type CreateManagedHiringOrderDto,
  type ManagedHiringCallbackDto,
  type ManagedHiringOrdersQuery,
  type ManagedHiringQuoteQuery,
} from "./managed-hiring.dto";
import {
  ManagedHiringService,
  type ManagedHiringCheckoutDto,
  type ManagedHiringQuoteDto,
  type PayerManagedHiringOrderDto,
} from "./managed-hiring.service";

/** The `reason` on the 400 an order without a valid `Idempotency-Key` gets. */
export const IDEMPOTENCY_KEY_REQUIRED = "idempotency_key_required" as const;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;

/**
 * #2751 items 4 to 13 — Managed Hiring, the company's side (brief section 2 and 4B.9).
 *
 *   GET  /payer/managed-hiring/quote?job_posting_id=   the tier, price (GST in paise), target, clock
 *                                                     terms — or `offer: "callback"` above 10 vacancies
 *   POST /payer/managed-hiring/orders                  start the checkout (Idempotency-Key REQUIRED);
 *                                                     answers the Razorpay handoff
 *   GET  /payer/managed-hiring/orders?job_posting_id=  the company's orders, newest first
 *   GET  /payer/managed-hiring/orders/:id              one order: status, clock, tracker
 *   POST /payer/managed-hiring/callback-requests       a job above the largest tier asks for a call
 *
 * Every route answers the neutral 404 while `MANAGED_HIRING_ROLLOUT` is off for the company or real
 * payments are off; an agency or contractor account gets a 403 `agency_account`. The payment itself
 * is verified on the shared `POST /payer/credits/verify` (or the webhook), which activates the order.
 */
@Controller("payer/managed-hiring")
@UseGuards(PayerAuthGuard)
export class PayerManagedHiringController {
  constructor(
    private readonly managedHiring: ManagedHiringService,
    private readonly idempotency: RequestIdempotency,
  ) {}

  @Get("quote")
  @Header("Cache-Control", "no-store")
  quote(
    @Query(new ZodValidationPipe(ManagedHiringQuoteQuerySchema)) query: ManagedHiringQuoteQuery,
    @CurrentPayer() payer: AuthenticatedPayer,
  ): Promise<ManagedHiringQuoteDto> {
    return this.managedHiring.quote(payer.id, query.job_posting_id);
  }

  /**
   * IDEMPOTENCY (#2751 item 6): the `Idempotency-Key` header is REQUIRED (400
   * `idempotency_key_required`), honoured on the house seam (namespace `payer_idem`, this route,
   * the SESSION payer) and BOUND TO THE BODY: a retry replays the first handoff and creates no
   * second Razorpay order; the same key with another body is a 422; a duplicate in flight is a 409
   * `in_flight`. Behind it, the database allows one open order per job.
   */
  @Post("orders")
  @HttpCode(201)
  async createOrder(
    @Body(new ZodValidationPipe(CreateManagedHiringOrderSchema)) dto: CreateManagedHiringOrderDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Req() req: Request,
    @Ctx() ctx: RequestContext,
  ): Promise<ManagedHiringCheckoutDto> {
    // OUTSIDE THE GUARD: a switched-off 404 is never pinned under a key.
    await this.managedHiring.assertOpenFor(payer.id);
    const key = req.header("idempotency-key")?.trim();
    if (!key || !IDEMPOTENCY_KEY_RE.test(key)) {
      throw new BadRequestException({
        statusCode: 400,
        error: "Bad Request",
        message:
          "An Idempotency-Key header is required: 8 to 200 characters of A-Z a-z 0-9 . _ : -",
        reason: IDEMPOTENCY_KEY_REQUIRED,
      });
    }
    return this.idempotency.runOnce({
      namespace: "payer_idem",
      scope: "managed_hiring_order",
      subject: payer.id,
      subjectLabel: "payer",
      logLabel: "payer",
      idempotencyKey: key,
      fingerprint: managedHiringOrderFingerprint(dto),
      inFlight: (): never => {
        throw inFlightConflict(
          "This checkout is already being prepared; wait a moment before trying again",
        );
      },
      work: () =>
        this.managedHiring.createOrder(
          payer.id,
          {
            jobPostingId: dto.job_posting_id,
            ...(dto.expected_price_inr !== undefined
              ? { expectedPriceInr: dto.expected_price_inr }
              : {}),
            ...(dto.origin !== undefined ? { origin: dto.origin } : {}),
          },
          ctx,
        ),
    });
  }

  @Get("orders")
  @Header("Cache-Control", "no-store")
  listOrders(
    @Query(new ZodValidationPipe(ManagedHiringOrdersQuerySchema)) query: ManagedHiringOrdersQuery,
    @CurrentPayer() payer: AuthenticatedPayer,
  ): Promise<{ orders: PayerManagedHiringOrderDto[] }> {
    return this.managedHiring.listOrders(payer.id, query.job_posting_id);
  }

  @Get("orders/:id")
  @Header("Cache-Control", "no-store")
  getOrder(
    @Param("id", new ParseUUIDPipe()) id: string,
    @CurrentPayer() payer: AuthenticatedPayer,
  ): Promise<PayerManagedHiringOrderDto> {
    return this.managedHiring.getOrder(payer.id, id);
  }

  @Post("callback-requests")
  @HttpCode(200)
  requestCallback(
    @Body(new ZodValidationPipe(ManagedHiringCallbackSchema)) dto: ManagedHiringCallbackDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ): Promise<{ request_id: string; job_posting_id: string; created: boolean }> {
    return this.managedHiring.requestCallback(payer.id, dto.job_posting_id, ctx);
  }
}
