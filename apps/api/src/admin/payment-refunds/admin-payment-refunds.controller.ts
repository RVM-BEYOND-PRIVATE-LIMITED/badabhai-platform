import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Ctx, type RequestContext } from "../../common/request-context";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  RefundEligibilityQuerySchema,
  RefundPaymentSchema,
  RetryRefundSchema,
  type RefundEligibilityQuery,
  type RefundPaymentDto,
  type RetryRefundDto,
} from "../../payment-refunds/payment-refunds.dto";
import {
  PaymentRefundsService,
  type RefundEligibilityView,
  type RefundView,
} from "../../payment-refunds/payment-refunds.service";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "../admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "../admin-roles.guard";

/**
 * #2750 items 10 and 12 — refunds of real paid packs in the admin console.
 *
 *   GET  /admin/payment-orders/:id/refund-eligibility  what each refund rule says today, and any
 *                                                      refund already made.
 *   POST /admin/payment-orders/:id/refund              refund the order in full under one rule.
 *   GET  /admin/payment-refunds/:id                    one refund and where it stands.
 *   POST /admin/payment-refunds/:id/retry              send a failed refund to Razorpay again.
 *
 * All four: {@link AdminAuthGuard} + {@link AdminRolesGuard}, capability `refund_payments`
 * (super_admin only; owner ruling 2026-11-18). 503 `CREDIT_NOTES_UNAVAILABLE` until GST credit
 * notes exist (owner ruling 2026-11-18), and 503 while real payments are off. Companies have no
 * refund route. The actor is always `@CurrentAdmin().id`.
 */
@Controller("admin")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminPaymentRefundsController {
  constructor(private readonly refunds: PaymentRefundsService) {}

  @Get("payment-orders/:id/refund-eligibility")
  @RequireAdminRole("refund_payments")
  refundEligibility(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Query(new ZodValidationPipe(RefundEligibilityQuerySchema)) query: RefundEligibilityQuery,
  ): Promise<RefundEligibilityView> {
    return this.refunds.eligibility(id, query.job_posting_id);
  }

  @Post("payment-orders/:id/refund")
  @HttpCode(200)
  @RequireAdminRole("refund_payments")
  refundOrder(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(RefundPaymentSchema)) dto: RefundPaymentDto,
    @Ctx() ctx: RequestContext,
  ): Promise<RefundView> {
    return this.refunds.refund(admin.id, id, dto, ctx);
  }

  @Get("payment-refunds/:id")
  @RequireAdminRole("refund_payments")
  getRefund(@Param("id", new ParseUUIDPipe()) id: string): Promise<RefundView> {
    return this.refunds.get(id);
  }

  @Post("payment-refunds/:id/retry")
  @HttpCode(200)
  @RequireAdminRole("refund_payments")
  retryRefund(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(RetryRefundSchema)) dto: RetryRefundDto,
    @Ctx() ctx: RequestContext,
  ): Promise<RefundView> {
    return this.refunds.retry(admin.id, id, dto.reason_text, ctx);
  }
}
