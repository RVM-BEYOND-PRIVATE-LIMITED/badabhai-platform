import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { ResumeDisclosureService } from "./resume-disclosure.service";
import {
  RequestDisclosureSchema,
  ListDisclosuresQuerySchema,
  type RequestDisclosureDto,
  type ListDisclosuresQueryDto,
} from "./resume-disclosure.dto";

/**
 * Resume Disclosure HTTP surface (ADR-0013 Decision C / the resume-disclosure
 * threat-model addendum). Thin — the fail-closed ordering, the identity masking
 * (B-G), the single decrypt, and event emission live in {@link ResumeDisclosureService}.
 *
 * GUARD (ALL routes): InternalServiceGuard — the INTERIM payer-auth seam (F-7 launch
 * gate, shared with unlock). There is NO per-payer identity yet; `payer_id` is trusted
 * from the body ONLY because the caller holds the shared secret. No production payer
 * surface ships on this guard (a real PayerAuthGuard + horizontal-authz test is a hard
 * launch gate — LC-A).
 *
 * There is intentionally NO bulk/list disclosure route (B-F anti-harvest): one
 * (payer, worker, posting) per request.
 */
@Controller()
@UseGuards(InternalServiceGuard)
export class ResumeDisclosureController {
  constructor(private readonly disclosures: ResumeDisclosureService) {}

  /**
   * Request the EMPLOYER-facing (identity-MASKED) resume for one worker. FREE. Returns
   * the ONE distinguishable success `{ ok, disclosure_id, status, resume_url, expires_at }`
   * (a short-TTL signed URL to the masked PDF), or the byte-identical neutral body for
   * EVERY deny branch (no_consent / capped / unknown / no-resume / render-unavailable).
   * HTTP 200 in all cases — the status is not an oracle (B-C). The response NEVER
   * contains a name, a phone, or the internal deny reason.
   */
  @Post("resume-disclosures")
  @HttpCode(200)
  requestDisclosure(
    @Body(new ZodValidationPipe(RequestDisclosureSchema)) dto: RequestDisclosureDto,
    @Ctx() ctx: RequestContext,
  ) {
    return this.disclosures.requestDisclosure(
      { payerId: dto.payer_id, workerId: dto.worker_id, jobPostingId: dto.job_posting_id },
      ctx,
    );
  }

  /** Ops: a payer's disclosures (PII-free projection — NO bytes / name / link). */
  @Get("resume-disclosures")
  listDisclosures(
    @Query(new ZodValidationPipe(ListDisclosuresQuerySchema)) query: ListDisclosuresQueryDto,
  ) {
    return this.disclosures.listByPayer(query.payer_id);
  }
}
