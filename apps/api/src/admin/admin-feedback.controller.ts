import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "./admin-roles.guard";
import { AdminFeedbackService } from "./admin-feedback.service";
import { AdminFeedbackQuerySchema, type AdminFeedbackQueryDto } from "./admin-feedback.dto";

/**
 * Read-only worker-FEEDBACK API for the Admin Portal (#997) — the ops half of the app-wide
 * Feedback button shipped in the worker app.
 *
 * WHY ITS OWN CONTROLLER. The route could have been a ninth method on
 * {@link import("./admin-entities.controller").AdminEntitiesController}, and that would have
 * been the wrong place: that controller's contract is FACELESS reads, pinned field-by-field in
 * `admin-entities.dto.ts` and enforced by a source scan over its repository. This read
 * deliberately projects worker-authored free text. Keeping it separate means the faceless
 * promise stays absolute where it is made, and this one exception is reviewable on its own.
 *
 * RBAC: {@link AdminAuthGuard} + {@link AdminRolesGuard} at the CLASS level, the capability at
 * the METHOD level (deny-by-default — a route that forgets the decorator is denied, not
 * opened). `read_identity` (super_admin, ops_admin, support) — OWNER RULING #2926 (option 1,
 * 2026-11-18). It was `read_entities`, which every role holds, and that let an `analyst` read
 * what workers typed: free text that can carry the worker's own name or phone number, plus
 * the photos they attached. An analyst sees neither anywhere else in the portal, so the read
 * moved to the capability that already gates names. Feedback triage is support's job.
 *
 * PII: `worker_id` is an opaque id. No name, no phone, no join that could grow one, and no
 * search over the message body. See the header of `admin-feedback.dto.ts` for the contract.
 *
 * AND THE COMPENSATING CONTROL (ADR-0025 Amendment 1): the read emits `admin.feedback_viewed`,
 * awaited and fail-closed, carrying the admin, the filters and the result count — never any
 * message text. This is the one read on the surface that returns a worker's own prose; the
 * narrower capability and the trail together are what make that acceptable. The ADMIN comes
 * from the session the guard resolved, never from the request.
 */
@Controller("admin")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminFeedbackController {
  constructor(private readonly service: AdminFeedbackService) {}

  @Get("feedback")
  @RequireAdminRole("read_identity")
  list(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Query(new ZodValidationPipe(AdminFeedbackQuerySchema)) query: AdminFeedbackQueryDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.service.list(admin.id, query, ctx);
  }
}
