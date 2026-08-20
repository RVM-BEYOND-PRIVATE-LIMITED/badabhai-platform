import { Controller, Get, Header, Param, Query, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminAiTraceFlagGuard } from "./admin-ai-trace-flag.guard";
import { AdminRolesGuard, RequireAdminRole } from "./admin-roles.guard";
import { AdminAiTracesService } from "./admin-ai-traces.service";
import {
  AdminAiTraceParamsSchema,
  AdminAiTracesQuerySchema,
  type AdminAiTraceDetail,
  type AdminAiTraceParamsDto,
  type AdminAiTracesQueryDto,
} from "./admin-ai-traces.dto";

/**
 * Read-only AI-CALL-TRACE API for the Admin Portal (migration 0083) — one surface, one gate.
 *
 * `GET /admin/ai-traces`      list, PII-FREE metadata.
 * `GET /admin/ai-traces/:id`  detail, DECRYPTS.
 *
 * BOTH are `read_ai_traces` (super_admin ONLY) behind the default-OFF
 * `ADMIN_AI_TRACE_READ_ENABLED` flag.
 *
 * ── WHY BOTH, WHEN THE LIST DISCLOSES NO TEXT ───────────────────────────────────────────
 * An earlier cut put the list on `read_entities`, the floor all four roles hold, and argued it
 * well: ops should be able to answer "which extraction calls failed this morning, and how big
 * were they" without being entitled to read what a worker said. That argument may be right, and
 * this file is not the place it gets decided. The owner ruling handed to the build was
 * "Read is gated on a NEW capability `read_ai_traces`, super_admin ONLY", and an agent widening
 * a stated ruling — even for a good reason, even to a PII-free projection — is exactly what
 * CLAUDE.md §16 reserves for a human.
 *
 * WHAT THE LIST ACTUALLY HANDS OVER, so the eventual ruling is made on the real thing rather
 * than on the word "metadata": `worker_id`, `session_id`, `task_type`, `created_at` and the two
 * character counts, keyset-walkable over the whole table. That is the LINKAGE — which worker,
 * which interview, when, how much they said — across the entire worker base, which is what
 * `packages/db/src/schema-contract.ts` names as the worst silent leak on this spine. It is a
 * genuinely different disclosure from a name, not a lesser version of one.
 *
 * TO REOPEN IT: change one decorator on {@link list} back to `read_entities`, drop
 * {@link AdminAiTraceFlagGuard} from that route, and re-point `apps/admin-web`'s nav entry. It
 * needs a ruling, not a redesign.
 *
 * ── THE CONTROLS, IN THE ORDER THEY FIRE ────────────────────────────────────────────────
 *  1. `AdminAuthGuard` → 401 for no session.
 *  2. `AdminAiTraceFlagGuard` → a NEUTRAL 404 for EVERY role while the flag is off, so the
 *     feature's existence is not observable. This is a GUARD and not a handler `if` precisely
 *     because Nest runs guards first: as an `if`, `@RequireAdminRole` fired ahead of it and
 *     three of the four roles got a 403 that confirmed the surface exists. See the guard.
 *  3. `read_ai_traces`, SUPER_ADMIN ONLY — the narrowest capability in the matrix alongside
 *     `toggle_kill_switch` and `manage_admins`. With the flag on, a 403 for a lesser role is
 *     the correct and honest answer.
 *  4. PER-ADMIN EGRESS CAP on its own Redis namespace, charged before the lookup, fail-closed.
 *     Detail only — the list decrypts nothing and charges nothing.
 *  5. AUDIT-BEFORE-DECRYPT — `admin.ai_trace_viewed`, awaited; no audit row, no text.
 *  6. `Cache-Control: no-store` on the detail, so a response body carrying a worker's own words
 *     cannot land in a shared proxy cache, a browser disk cache, or a bfcache entry that
 *     outlives the session. The same Control 8 the reveal route carries, for a larger body.
 *
 * SINGLE-SUBJECT BY CONSTRUCTION: exactly one `:id`. There is no export, no range and no batch
 * decrypt route, and there must never be one — every control above assumes this is the only way
 * text leaves, and a bulk route would go around all of them at once.
 *
 * READ-ONLY BY CONSTRUCTION: both routes are GETs. `ai_call_traces` is append-only; its one
 * writer is `AiTraceRecorder` in `AiModule`, which is not reachable from this module.
 */
@Controller("admin")
@UseGuards(AdminAuthGuard, AdminAiTraceFlagGuard, AdminRolesGuard)
export class AdminAiTracesController {
  constructor(private readonly service: AdminAiTracesService) {}

  /**
   * GET /admin/ai-traces — one keyset page of PII-FREE trace metadata.
   *
   * NO `Cache-Control: no-store`, deliberately. That header is a claim about the BODY, and this
   * body carries no decrypted PII; spraying it across routes that do not disclose would make it
   * decorative and the next reviewer could no longer read its presence as "this response may
   * contain plaintext". Same rule `admin-static-guards.test.ts` pins for the faceless entity
   * routes.
   */
  @Get("ai-traces")
  @RequireAdminRole("read_ai_traces")
  list(@Query(new ZodValidationPipe(AdminAiTracesQuerySchema)) query: AdminAiTracesQueryDto) {
    return this.service.list(query);
  }

  /**
   * GET /admin/ai-traces/:id — the DECRYPT. See the class header for every control.
   *
   * There is no flag check in this body any more: `AdminAiTraceFlagGuard` ran before the roles
   * guard and threw the neutral 404 for every role. `AdminAiTracesService.readOne` still
   * re-checks the flag as defence in depth, and throws the identical shape.
   */
  @Get("ai-traces/:id")
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("read_ai_traces")
  readOne(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Param(new ZodValidationPipe(AdminAiTraceParamsSchema)) params: AdminAiTraceParamsDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminAiTraceDetail> {
    return this.service.readOne(admin, params.id, ctx);
  }
}
