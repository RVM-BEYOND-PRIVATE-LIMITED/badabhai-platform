import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { Ctx, type RequestContext } from "../../common/request-context";
import {
  AddManagedHiringInterestSchema,
  AdminCallbackRequestsQuerySchema,
  AdminManagedHiringOrdersQuerySchema,
  RemoveManagedHiringInterestSchema,
  type AddManagedHiringInterestDto,
  type AdminCallbackRequestsQuery,
  type AdminManagedHiringOrdersQuery,
  type RemoveManagedHiringInterestDto,
} from "../../managed-hiring/managed-hiring.dto";
import {
  ManagedHiringService,
  type AdminManagedHiringOrderDetailDto,
  type AdminManagedHiringOrderDto,
  type CallbackRequestDto,
} from "../../managed-hiring/managed-hiring.service";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "../admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "../admin-roles.guard";

/**
 * #2751 items 8 and 12 — the Managed Hiring desk (staff tool in the admin console; screens are
 * Rishi's). The paths are the issue's.
 *
 *   GET    /admin/managed-hiring/orders?status=open|ended|all   every company's paid orders
 *   GET    /admin/managed-hiring/orders/:id                     one order and its tracker (with notes)
 *   POST   /admin/managed-hiring/orders/:id/interest            add a phone-confirmed worker + note
 *   DELETE /admin/managed-hiring/orders/:id/interest            take one off (worker + reason)
 *   GET    /admin/managed-hiring/callback-requests              jobs above the largest tier
 *
 * All: {@link AdminAuthGuard} + {@link AdminRolesGuard}, capability `work_managed_hiring`
 * (super_admin, ops_admin, support; owner ruling 2026-11-18); 404 while the `managed_hiring` switch
 * is off everywhere, 503 with it on and the tables missing. A refusal is a 409 with a stable
 * `reason` (`order_not_open`, `already_on_tracker`, `worker_unavailable`, `no_sharing_consent`,
 * `rvm_student_not_applied`). The desk calls the worker through the existing reason-gated reveal;
 * nothing here returns a number. The actor is always `@CurrentAdmin().id`.
 */
@Controller("admin/managed-hiring")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminManagedHiringController {
  constructor(private readonly managedHiring: ManagedHiringService) {}

  @Get("orders")
  @RequireAdminRole("work_managed_hiring")
  listOrders(
    @Query(new ZodValidationPipe(AdminManagedHiringOrdersQuerySchema))
    query: AdminManagedHiringOrdersQuery,
  ): Promise<{ orders: AdminManagedHiringOrderDto[]; next_cursor: string | null }> {
    return this.managedHiring.listOrdersForAdmin({
      status: query.status,
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });
  }

  @Get("orders/:id")
  @RequireAdminRole("work_managed_hiring")
  getOrder(
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<AdminManagedHiringOrderDetailDto> {
    return this.managedHiring.getOrderForAdmin(id);
  }

  @Post("orders/:id/interest")
  @HttpCode(200)
  @RequireAdminRole("work_managed_hiring")
  addInterest(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(AddManagedHiringInterestSchema)) dto: AddManagedHiringInterestDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminManagedHiringOrderDetailDto> {
    return this.managedHiring.addInterest(admin.id, id, dto.worker_id, dto.note, ctx);
  }

  @Delete("orders/:id/interest")
  @HttpCode(200)
  @RequireAdminRole("work_managed_hiring")
  removeInterest(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(RemoveManagedHiringInterestSchema))
    dto: RemoveManagedHiringInterestDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminManagedHiringOrderDetailDto> {
    return this.managedHiring.removeInterest(admin.id, id, dto.worker_id, dto.reason_text, ctx);
  }

  @Get("callback-requests")
  @RequireAdminRole("work_managed_hiring")
  listCallbacks(
    @Query(new ZodValidationPipe(AdminCallbackRequestsQuerySchema))
    query: AdminCallbackRequestsQuery,
  ): Promise<{ requests: CallbackRequestDto[]; next_cursor: string | null }> {
    return this.managedHiring.listCallbacksForAdmin({
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });
  }
}
