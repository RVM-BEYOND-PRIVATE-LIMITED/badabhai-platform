import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard } from "./admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "./admin-roles.guard";
import { AdminFinanceService } from "./admin-finance.service";
import {
  AdminFinanceSummaryQuerySchema,
  AdminLedgerQuerySchema,
  AdminOrdersQuerySchema,
  type AdminFinanceSummaryQueryDto,
  type AdminLedgerQueryDto,
  type AdminOrdersQueryDto,
} from "./admin-finance.dto";

/**
 * Read-only FINANCE API for the Admin Portal (BP-2) — credit position, the platform-wide
 * credit ledger, and payment orders.
 *
 * ── WHY `read_entities` AND NOT A NEW CAPABILITY ────────────────────────────────────────
 * ADR-0025 Decision 3.1 grants all four roles both "Read entities" and "Read metrics /
 * dashboards". These routes are exactly that pair: `payer_credits`, `credit_ledger` and
 * `payment_orders` are entities, and the summary is a metric over them. Minting a
 * `read_finance` capability would be a NEW row in a signed matrix — an ADR change — to
 * express an allow-set identical to the one that already exists.
 *
 * That is a real judgement, not an omission: reading a balance is separated from CHANGING
 * one, which stays `grant_credits` (super_admin + ops_admin). An analyst investigating a
 * billing complaint can see that a number is wrong without gaining the ability to alter it.
 *
 * ── NO PII, NO EXTERNAL REFS ────────────────────────────────────────────────────────────
 * Opaque payer ids, integer ₹ amounts, closed enums, timestamps. Provider order/payment
 * references are not projected — see the repository header.
 */
@Controller("admin/finance")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminFinanceController {
  constructor(private readonly service: AdminFinanceService) {}

  /** Credit position + windowed movement + order outcomes. Carries the payments posture. */
  @Get("summary")
  @RequireAdminRole("read_entities")
  summary(
    @Query(new ZodValidationPipe(AdminFinanceSummaryQuerySchema))
    query: AdminFinanceSummaryQueryDto,
  ) {
    return this.service.summary(query);
  }

  /** The append-only credit ledger, platform-wide, keyset-paginated. */
  @Get("ledger")
  @RequireAdminRole("read_entities")
  ledger(@Query(new ZodValidationPipe(AdminLedgerQuerySchema)) query: AdminLedgerQueryDto) {
    return this.service.ledger(query);
  }

  /** Payment orders (credit-pack purchases), keyset-paginated. */
  @Get("orders")
  @RequireAdminRole("read_entities")
  orders(@Query(new ZodValidationPipe(AdminOrdersQuerySchema)) query: AdminOrdersQueryDto) {
    return this.service.orders(query);
  }
}
