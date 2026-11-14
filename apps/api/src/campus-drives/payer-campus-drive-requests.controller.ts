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
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { CurrentPayer, PayerAuthGuard, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerRoleGuard, PayerRoles } from "../payers/payer-role.guard";
import { DriveIdempotencyKey } from "./campus-drive-http";
import {
  PayerCreateCampusDriveRequestSchema,
  PayerListCampusDriveRequestsQuerySchema,
  type PayerCampusDriveRequestPage,
  type PayerCampusDriveRequestView,
  type PayerCreateCampusDriveRequestDto,
  type PayerListCampusDriveRequestsQueryDto,
} from "./campus-drive-requests.dto";
import { CampusDriveRequestsService } from "./campus-drive-requests.service";

/**
 * #2746 PR 6 — a company's campus-drive requests (`/payer/campus-drive-requests`). HTTP ONLY: the
 * rules are `CampusDriveRequestsService`'s.
 *
 * EMPLOYER-ONLY, every route, reads included (`@PayerRoles("employer")` on each handler, the
 * #1885 mechanism): an agency or contractor account cannot ask for a drive (the issue's default),
 * and gets the house `PayerRoleGuard` 403. The company is the SESSION's (`req.payer.id`, resolved
 * to its tenant key by the service); no body or path carries a company id. Every route is the
 * neutral 404 while the `campus_drive_requests` switch is not live for the company.
 */
@Controller("payer/campus-drive-requests")
@UseGuards(PayerAuthGuard, PayerRoleGuard)
export class PayerCampusDriveRequestsController {
  constructor(private readonly drives: CampusDriveRequestsService) {}

  /** Ask for a campus drive. `Idempotency-Key` required; a repeat answers the first request. */
  @Post()
  @HttpCode(201)
  @PayerRoles("employer")
  create(
    @Body(new ZodValidationPipe(PayerCreateCampusDriveRequestSchema))
    dto: PayerCreateCampusDriveRequestDto,
    @DriveIdempotencyKey() idempotencyKey: string,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ): Promise<PayerCampusDriveRequestView> {
    return this.drives.create(payer.id, dto, idempotencyKey, ctx);
  }

  /** The company's own requests, newest first. */
  @Get()
  @PayerRoles("employer")
  list(
    @Query(new ZodValidationPipe(PayerListCampusDriveRequestsQuerySchema))
    query: PayerListCampusDriveRequestsQueryDto,
    @CurrentPayer() payer: AuthenticatedPayer,
  ): Promise<PayerCampusDriveRequestPage> {
    return this.drives.list(payer.id, query);
  }

  /** One of the company's own requests; an unknown or foreign id is the neutral 404. */
  @Get(":id")
  @PayerRoles("employer")
  getOne(
    @Param("id", new ParseUUIDPipe()) id: string,
    @CurrentPayer() payer: AuthenticatedPayer,
  ): Promise<PayerCampusDriveRequestView> {
    return this.drives.getOne(payer.id, id);
  }

  /** Cancel a `requested` or `scheduled` request. A repeat cancel is a 200 with no change. */
  @Post(":id/cancel")
  @HttpCode(200)
  @PayerRoles("employer")
  cancel(
    @Param("id", new ParseUUIDPipe()) id: string,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ): Promise<PayerCampusDriveRequestView> {
    return this.drives.cancel(payer.id, id, ctx);
  }
}
