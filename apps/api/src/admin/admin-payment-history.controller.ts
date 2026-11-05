import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard } from "./admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "./admin-roles.guard";
import { AdminPaymentHistoryService } from "./admin-payment-history.service";
import {
  AdminPaymentHistoryParamsSchema,
  AdminPaymentHistoryQuerySchema,
  type AdminPaymentHistoryParamsDto,
  type AdminPaymentHistoryQueryDto,
} from "./admin-payment-history.dto";

/**
 * Read-only PER-COMPANY payment-history API for the Admin Portal (#2565 B11) —
 * the one timeline answering "what have we paid for?".
 *
 * ── WHY `read_entities` AND NOT A NEW CAPABILITY ─────────────────────────────────
 * The finance surface's documented call (same allow-set as every read-floor
 * route): this is the company-scoped cut of the same money — payment orders,
 * the credit ledger, plans, boosts, capacity and top-ups — with the org rollup
 * the platform endpoints cannot do. Minting a capability would be an ADR change
 * for an allow-set identical to the one that already exists.
 *
 * Every route: `AdminAuthGuard` + `AdminRolesGuard`, capability declared at the
 * METHOD level (a route that forgets the decorator is DENIED, never opened).
 */
@Controller("admin/payers/:id")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminPaymentHistoryController {
  constructor(private readonly service: AdminPaymentHistoryService) {}

  /**
   * One company's timeline: orders, ledger purchases/grants/spend, plans,
   * boosts, capacity and top-ups in date order, with totals. `:id` is ANY payer
   * in the company — team members' purchases roll up to it.
   */
  @Get("payment-history")
  @RequireAdminRole("read_entities")
  history(
    @Param(new ZodValidationPipe(AdminPaymentHistoryParamsSchema))
    params: AdminPaymentHistoryParamsDto,
    @Query(new ZodValidationPipe(AdminPaymentHistoryQuerySchema))
    query: AdminPaymentHistoryQueryDto,
  ) {
    return this.service.history(params.id, query);
  }
}
