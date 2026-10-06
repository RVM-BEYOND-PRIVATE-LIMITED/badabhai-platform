import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard } from "./admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "./admin-roles.guard";
import { AdminMatchEngineService } from "./admin-match-engine.service";
import {
  EnginePostingParamsSchema,
  EngineRecentWorkersQuerySchema,
  EngineWorkerParamsSchema,
  type EnginePostingParamsDto,
  type EngineRecentWorkersQueryDto,
  type EngineWorkerParamsDto,
} from "./admin-match-engine.dto";

/**
 * Read-only ENGINE VIEW for the Admin Portal's Matching group — how Matching V1 decides what
 * a worker sees (skills → reach funnel → feed in feed order) and who a posting reaches
 * (reach set by tier → ranked candidates).
 *
 * ══ RBAC: `read_entities` ═══════════════════════════════════════════════════════════════
 * The data class is the entity floor's: opaque uuids (and an 8-char prefix of one),
 * closed-vocabulary skill ids and labels, enums, integers, timestamps, posting role titles —
 * all of which `GET /admin/workers/:id`, `GET /admin/job-postings/:id` and the skill-discovery
 * reads already serve to every role on `read_entities`. Nothing here is identity (no
 * `read_identity`), contact (no `reveal_pii`) or a write. No new capability is minted.
 *
 * HTTP only: validation is the zod pipe, the decision is the service's.
 */
@Controller("admin/match/engine")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminMatchEngineController {
  constructor(private readonly service: AdminMatchEngineService) {}

  @Get("workers")
  @RequireAdminRole("read_entities")
  listRecentWorkers(
    @Query(new ZodValidationPipe(EngineRecentWorkersQuerySchema))
    query: EngineRecentWorkersQueryDto,
  ) {
    return this.service.listRecentWorkers(query.recent);
  }

  @Get("workers/:workerId")
  @RequireAdminRole("read_entities")
  getWorkerView(
    @Param(new ZodValidationPipe(EngineWorkerParamsSchema)) params: EngineWorkerParamsDto,
  ) {
    return this.service.getWorkerView(params.workerId);
  }

  @Get("postings/:postingId")
  @RequireAdminRole("read_entities")
  getPostingView(
    @Param(new ZodValidationPipe(EnginePostingParamsSchema)) params: EnginePostingParamsDto,
  ) {
    return this.service.getPostingView(params.postingId);
  }
}
