import { Body, Controller, Header, HttpCode, Post, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AdminAuthGuard, CurrentAdmin, type AuthenticatedAdmin } from "./admin-auth.guard";
import { AdminRolesGuard, RequireAdminRole } from "./admin-roles.guard";
import {
  AdminCandidateSearchSchema,
  type AdminCandidateSearchDto,
  type AdminCandidateSearchResponse,
} from "./admin-candidates.dto";
import { AdminCandidatesService } from "./admin-candidates.service";

/**
 * The Candidates data-bank search (B5, #2559 — ADR-0062 §3.6).
 *
 * POST (not GET): the free-text `q` travels in the BODY ONLY — never in a URL,
 * route, error or validation message (the term must never reach a log line).
 * The read-only-verb structural rule (`admin-static-guards.test.ts`) is
 * amended DELIBERATELY here with the ADR citation: a GET would put the term in
 * access logs, which is exactly what §3.6 forbids.
 *
 * One capability per route (`read_candidates`, the read floor — names are
 * additive via `read_identity` inside the service, never a second decorator).
 * Name-bearing unconditionally: `Cache-Control: no-store`.
 */
@Controller("admin")
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminCandidatesController {
  constructor(private readonly candidates: AdminCandidatesService) {}

  @Post("candidates/search")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @RequireAdminRole("read_candidates")
  async search(
    @CurrentAdmin() admin: AuthenticatedAdmin,
    @Body(new ZodValidationPipe(AdminCandidateSearchSchema)) dto: AdminCandidateSearchDto,
    @Ctx() ctx: RequestContext,
  ): Promise<AdminCandidateSearchResponse> {
    return this.candidates.search(admin, dto, ctx);
  }
}
