import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard } from "./admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "./admin-roles.guard";
import { AdminEmptyFeedService } from "./admin-empty-feed.service";
import {
  AdminEmptyFeedQuerySchema,
  type AdminEmptyFeedPage,
  type AdminEmptyFeedQueryDto,
} from "./admin-empty-feed.dto";

/**
 * #2569 (B15) — workers whose active feed would serve them nothing.
 *
 * `read_entities` is the read floor for all four roles: the payload is faceless (worker id,
 * trade, city, profile status, age in days) and carries no name, phone, email or ciphertext.
 *
 * ROUTE ORDER IS LOAD-BEARING: `workers/empty-feed` is a LITERAL sibling of
 * `AdminEntitiesController`'s `workers/:id`, and the literal must be registered first or the
 * param route's UUID validation answers 400 for this screen. `AdminModule` registers this
 * controller before `AdminEntitiesController`, and `admin-static-guards.test.ts` pins that.
 */
@Controller("admin")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminEmptyFeedController {
  constructor(private readonly service: AdminEmptyFeedService) {}

  @Get("workers/empty-feed")
  @RequireAdminRole("read_entities")
  list(
    @Query(new ZodValidationPipe(AdminEmptyFeedQuerySchema)) query: AdminEmptyFeedQueryDto,
  ): Promise<AdminEmptyFeedPage> {
    return this.service.list(query);
  }
}
