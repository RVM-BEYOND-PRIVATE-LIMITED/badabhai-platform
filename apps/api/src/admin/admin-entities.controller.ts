import { Controller, Get, Header, Param, Query, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "./admin-roles.guard";
import { AdminEntitiesService } from "./admin-entities.service";
import {
  AdminApplicationsQuerySchema,
  AdminCreditLedgerQuerySchema,
  AdminEntityParamsSchema,
  AdminPayerDetailQuerySchema,
  type AdminPayerDetailQueryDto,
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
 *
 * NAMES (owner ruling 2026-08-18, reversing ADR-0025 Decision 4): the worker and payer routes
 * additionally carry `full_name` / `org_name` — but ONLY for an admin holding `read_identity`
 * (super_admin / ops_admin / support; `analyst` denied) and only within their name-egress
 * budget. That second gate is deliberately NOT a second decorator: `@RequireAdminRole` declares
 * exactly one capability per route, and these routes must stay reachable on `read_entities` for
 * every role because the names are ADDITIVE — an analyst gets the identical faceless response.
 * The check is an explicit `can(admin.role, "read_identity")` inside `AdminIdentityService`,
 * over the session admin threaded here by `@CurrentAdmin()`, which is why these four handlers
 * take one where the other four do not.
 */
@Controller("admin")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminEntitiesController {
  constructor(private readonly service: AdminEntitiesService) {}

  // ---- workers ------------------------------------------------------------
  //
  // `Cache-Control: no-store` on the four NAME-BEARING handlers, the same header and the same
  // reason as the reveal route's Control 8: the response body may contain decrypted PII, so it
  // must not be written to a shared proxy cache, a browser disk cache, or a bfcache entry that
  // outlives the session. It is set UNCONDITIONALLY rather than only when a name was actually
  // disclosed — a header that varies with the caller's capability is a cache-poisoning bug
  // waiting to happen (an analyst's cacheable faceless page served to an ops_admin, or worse
  // the reverse), and it would leak whether the caller holds `read_identity` to any observer
  // of the headers. The four faceless routes below deliberately do NOT carry it.

  @Get("workers")
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("read_entities")
  listWorkers(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Query(new ZodValidationPipe(AdminWorkersQuerySchema)) query: AdminWorkersQueryDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.listWorkers(admin, query, ctx);
  }

  @Get("workers/:id")
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("read_entities")
  getWorker(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminEntityParamsSchema)) params: AdminEntityParamsDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.getWorker(admin, params.id, ctx);
  }

  // ---- payers (Companies = role:employer, Agencies = role:agent) -----------

  @Get("payers")
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("read_entities")
  listPayers(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Query(new ZodValidationPipe(AdminPayersQuerySchema)) query: AdminPayersQueryDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.listPayers(admin, query, ctx);
  }

  @Get("payers/:id")
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("read_entities")
  getPayer(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminEntityParamsSchema)) params: AdminEntityParamsDto,
    @Query(new ZodValidationPipe(AdminPayerDetailQuerySchema)) query: AdminPayerDetailQueryDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.getPayer(admin, params.id, ctx, { faceless: query.faceless === "1" });
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
