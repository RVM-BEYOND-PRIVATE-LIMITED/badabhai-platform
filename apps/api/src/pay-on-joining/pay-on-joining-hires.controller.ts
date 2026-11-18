import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "../admin/admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "../admin/admin-roles.guard";
import type { AdminPage } from "../admin/admin-entities.dto";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { Ctx, type RequestContext } from "../common/request-context";
import {
  CreatePojHireSchema,
  ListPojHiresQuerySchema,
  PojHireParamsSchema,
  UpdatePojHireSchema,
  type CreatePojHireDto,
  type ListPojHiresQueryDto,
  type PojHireParamsDto,
  type PojHireView,
  type PojHireWriteResult,
  type UpdatePojHireDto,
} from "./pay-on-joining-hires.dto";
import { PayOnJoiningHiresService } from "./pay-on-joining-hires.service";
import { PayOnJoiningFlagGuard } from "./pay-on-joining.flag.guard";

/**
 * #2753 item 11 — the pay-on-joining pilot's hire record, written by hand by an admin.
 *
 *   GET   /admin/pay-on-joining-hires        manage_companies   keyset page (factory, partner, paid)
 *   POST  /admin/pay-on-joining-hires        manage_companies   record a hire
 *   PATCH /admin/pay-on-joining-hires/:id    manage_companies   edit it
 *
 * THE CAPABILITY. `manage_companies` (super_admin + ops_admin), reused, not a new matrix row: a
 * hire record is part of a company's commercial record (the factory and the partner are payers;
 * the fee is what the factory owes), the surface #2564 already gates on this row. The LIST shares
 * it rather than the `read_entities` floor, because the list is the pilot's commercial terms per
 * company and the admin's notes, not a faceless projection. `grant_credits` was the other
 * candidate and is refused: it moves a balance, and nothing here moves anything.
 *
 * THE ORDER: `AdminAuthGuard` (401), `PayOnJoiningFlagGuard` (a neutral 404 for every role while
 * `PAY_ON_JOINING_RECORDS_ENABLED` is off, before any query), then `AdminRolesGuard` (403). ONE
 * method-level capability per route, none on the class. `Cache-Control: no-store` on all three,
 * because every body can carry the admin's note.
 */
@Controller("admin/pay-on-joining-hires")
@UseGuards(AdminAuthGuard, PayOnJoiningFlagGuard, AdminRolesGuard)
export class PayOnJoiningHiresController {
  constructor(private readonly service: PayOnJoiningHiresService) {}

  @Get()
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("manage_companies")
  listHires(
    @Query(new ZodValidationPipe(ListPojHiresQuerySchema)) query: ListPojHiresQueryDto,
  ): Promise<AdminPage<PojHireView>> {
    return this.service.list(query);
  }

  @Post()
  @HttpCode(201)
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("manage_companies")
  createHire(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(CreatePojHireSchema)) dto: CreatePojHireDto,
    @Ctx() ctx: RequestContext,
  ): Promise<PojHireWriteResult> {
    return this.service.create(admin, dto, ctx);
  }

  @Patch(":id")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("manage_companies")
  updateHire(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(PojHireParamsSchema)) params: PojHireParamsDto,
    @Body(new ZodValidationPipe(UpdatePojHireSchema)) dto: UpdatePojHireDto,
    @Ctx() ctx: RequestContext,
  ): Promise<PojHireWriteResult> {
    return this.service.update(admin, params.id, dto, ctx);
  }
}
