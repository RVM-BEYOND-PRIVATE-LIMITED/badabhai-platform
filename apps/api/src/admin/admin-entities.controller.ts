import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard } from "./admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "./admin-roles.guard";
import { AdminEntitiesService } from "./admin-entities.service";
import {
  AdminApplicationsQuerySchema,
  AdminCreditLedgerQuerySchema,
  AdminEntityParamsSchema,
  AdminJobPostingsQuerySchema,
  AdminPayersQuerySchema,
  AdminWorkersQuerySchema,
  type AdminApplicationsQueryDto,
  type AdminCreditLedgerQueryDto,
  type AdminEntityParamsDto,
  type AdminJobPostingsQueryDto,
  type AdminPayersQueryDto,
  type AdminWorkersQueryDto,
} from "./admin-entities.dto";

/**
 * Read-only FACELESS entity API for the Admin Portal (BP-1) — ADR-0025 Decision 3.1 row 2.
 *
 * WHY THIS EXISTS. The governed admin ACTIONS shipped before any way to reach their targets:
 * an admin could `POST /admin/payers/:id/suspend` but had no route that would ever tell them
 * an `:id`. The only entity reads on the platform sat behind `InternalServiceGuard`, which is
 * a shared-secret service principal, not a per-person admin identity — so the portal's choices
 * were to hand a browser a service token or to leave the actions unreachable.
 *
 * This is the third option, and the additive one: the SAME rows, projected faceless, behind
 * the admin's OWN session and capability. `InternalServiceGuard` is NOT widened, the ops
 * console (`apps/web`) is NOT touched, and no existing route changes shape. OBS-4 (retiring
 * the internal routes behind a dual-accept guard) stays deferred and is unaffected.
 *
 * RBAC: every route carries {@link AdminAuthGuard} + {@link AdminRolesGuard} and declares
 * `read_entities` at the METHOD level (deny-by-default; a route that forgets the decorator is
 * denied, not opened). All four roles hold it — the ADR's read floor.
 *
 * PII: the projections are ids + enums + timestamps + counts. The one class of human-readable
 * text on this surface is the poster-typed job-posting fields, which are already worker-visible
 * in the feed. See the header of `admin-entities.dto.ts` for the field-by-field contract.
 */
@Controller("admin")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminEntitiesController {
  constructor(private readonly service: AdminEntitiesService) {}

  // ---- workers ------------------------------------------------------------

  @Get("workers")
  @RequireAdminRole("read_entities")
  listWorkers(@Query(new ZodValidationPipe(AdminWorkersQuerySchema)) query: AdminWorkersQueryDto) {
    return this.service.listWorkers(query);
  }

  @Get("workers/:id")
  @RequireAdminRole("read_entities")
  getWorker(@Param(new ZodValidationPipe(AdminEntityParamsSchema)) params: AdminEntityParamsDto) {
    return this.service.getWorker(params.id);
  }

  // ---- payers (Companies = role:employer, Agencies = role:agent) -----------

  @Get("payers")
  @RequireAdminRole("read_entities")
  listPayers(@Query(new ZodValidationPipe(AdminPayersQuerySchema)) query: AdminPayersQueryDto) {
    return this.service.listPayers(query);
  }

  @Get("payers/:id")
  @RequireAdminRole("read_entities")
  getPayer(@Param(new ZodValidationPipe(AdminEntityParamsSchema)) params: AdminEntityParamsDto) {
    return this.service.getPayer(params.id);
  }

  /**
   * Balance + append-only ledger for one payer. A READ of the same money the `grant_credits`
   * capability writes — and deliberately NOT gated on `grant_credits`: seeing that a balance
   * is wrong and being allowed to change it are different privileges, and collapsing them
   * would mean an analyst investigating a billing complaint needs the ability to alter it.
   */
  @Get("payers/:id/credits")
  @RequireAdminRole("read_entities")
  getPayerCredits(
    @Param(new ZodValidationPipe(AdminEntityParamsSchema)) params: AdminEntityParamsDto,
    @Query(new ZodValidationPipe(AdminCreditLedgerQuerySchema)) query: AdminCreditLedgerQueryDto,
  ) {
    return this.service.getCredits(params.id, query);
  }

  // ---- job postings -------------------------------------------------------

  @Get("job-postings")
  @RequireAdminRole("read_entities")
  listJobPostings(
    @Query(new ZodValidationPipe(AdminJobPostingsQuerySchema)) query: AdminJobPostingsQueryDto,
  ) {
    return this.service.listJobPostings(query);
  }

  @Get("job-postings/:id")
  @RequireAdminRole("read_entities")
  getJobPosting(
    @Param(new ZodValidationPipe(AdminEntityParamsSchema)) params: AdminEntityParamsDto,
  ) {
    return this.service.getJobPosting(params.id);
  }

  // ---- applications -------------------------------------------------------

  @Get("applications")
  @RequireAdminRole("read_entities")
  listApplications(
    @Query(new ZodValidationPipe(AdminApplicationsQuerySchema)) query: AdminApplicationsQueryDto,
  ) {
    return this.service.listApplications(query);
  }
}
