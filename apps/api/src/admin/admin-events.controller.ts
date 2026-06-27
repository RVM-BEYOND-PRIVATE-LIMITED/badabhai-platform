import { Controller, Get, Header, Param, Query, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "./admin-roles.guard";
import { AdminEventsService } from "./admin-events.service";
import {
  AdminEventsQuerySchema,
  AdminExportQuerySchema,
  AdminMetricsQuerySchema,
  AdminTimelineParamsSchema,
  AdminTimelineQuerySchema,
  type AdminEventsQueryDto,
  type AdminExportQueryDto,
  type AdminMetricsQueryDto,
  type AdminTimelineParamsDto,
  type AdminTimelineQueryDto,
} from "./admin-events.dto";

/**
 * Read-only Admin Ops Portal event-spine API (ADR-0025 ADMIN-2) — makes the immutable event
 * spine EXPLORABLE: query/detail/trace/timeline/metrics/export. SELECT-ONLY over `events`.
 *
 * RBAC (deny-by-default, one principal + one role per route):
 *   - EVERY route is behind {@link AdminAuthGuard} + {@link AdminRolesGuard}.
 *   - The five READ routes require `read_events` (all four admin roles — the read floor).
 *   - `export` requires the `export` capability (super_admin + ops_admin ONLY; support/analyst
 *     are DENIED — the reveal role must not also bulk-export).
 *
 * PII-FREE: event payloads are PII-free by registry construction; the projections are ids +
 * enums + timestamps + codes only. The metrics funnel applies a k-anon floor (no worker oracle).
 *
 * SSE live-tail (`GET /admin/events/stream`) is DEFERRED to ADMIN-7 (the monitoring UI phase) —
 * it needs streaming infra out of this PR's query/detail/trace/timeline/metrics/export scope.
 */
@Controller("admin")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminEventsController {
  constructor(private readonly service: AdminEventsService) {}

  /** Route #1 — keyset-paginated, filtered event list. */
  @Get("events")
  @RequireAdminRole("read_events")
  list(@Query(new ZodValidationPipe(AdminEventsQuerySchema)) query: AdminEventsQueryDto) {
    return this.service.list(query);
  }

  /** Route #5 — dashboard aggregates (k-anon-floored funnel). Declared BEFORE `:id`. */
  @Get("events/metrics")
  @RequireAdminRole("read_events")
  metrics(@Query(new ZodValidationPipe(AdminMetricsQuerySchema)) query: AdminMetricsQueryDto) {
    return this.service.metrics(query);
  }

  /**
   * Route #6 — bounded export of PII-free events. `export` capability (super_admin/ops_admin
   * only). Emits the audited `admin.action_performed`. Declared BEFORE `:id`.
   */
  @Get("events/export")
  @RequireAdminRole("export")
  @Header("Cache-Control", "no-store")
  export(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Query(new ZodValidationPipe(AdminExportQuerySchema)) query: AdminExportQueryDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.export(admin.id, query, ctx);
  }

  /**
   * Route #3 — the causal chain for a correlation id. Declared BEFORE `:id` so `trace` is not
   * captured by the `:id` param route.
   */
  @Get("events/trace/:correlationId")
  @RequireAdminRole("read_events")
  trace(@Param("correlationId") correlationId: string) {
    return this.service.trace(correlationId);
  }

  /** Route #2 — full PII-free event detail. */
  @Get("events/:id")
  @RequireAdminRole("read_events")
  getOne(@Param("id") id: string) {
    return this.service.getById(id);
  }

  /** Route #4 — every event for a whitelisted subject, keyset-paginated. */
  @Get("entities/:type/:id/timeline")
  @RequireAdminRole("read_events")
  timeline(
    @Param(new ZodValidationPipe(AdminTimelineParamsSchema)) params: AdminTimelineParamsDto,
    @Query(new ZodValidationPipe(AdminTimelineQuerySchema)) query: AdminTimelineQueryDto,
  ) {
    return this.service.timeline(params.type, params.id, query);
  }
}
