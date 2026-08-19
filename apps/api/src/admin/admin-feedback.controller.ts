import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard } from "./admin-auth.guard";
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
 * opened). `read_entities`, the ADR-0025 read floor all four roles hold: the issue rules that
 * showing feedback to admins is fine, and a new capability would be a product decision about
 * who may read it, which nobody has made (CLAUDE.md §16). Tightening it later is one line
 * here plus one on the portal nav item.
 *
 * PII: `worker_id` is an opaque id. No name, no phone, no join that could grow one, and no
 * search over the message body. See the header of `admin-feedback.dto.ts` for the contract.
 */
@Controller("admin")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminFeedbackController {
  constructor(private readonly service: AdminFeedbackService) {}

  @Get("feedback")
  @RequireAdminRole("read_entities")
  list(@Query(new ZodValidationPipe(AdminFeedbackQuerySchema)) query: AdminFeedbackQueryDto) {
    return this.service.list(query);
  }
}
