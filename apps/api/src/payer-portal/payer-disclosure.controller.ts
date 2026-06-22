import { Body, Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { PayerAuthGuard, CurrentPayer, type AuthenticatedPayer } from "../payers/payer-auth.guard";
import { PayerDisclosureRateLimit } from "../payers/payer-disclosure-rate-limit.service";
import { ResumeDisclosureService } from "../disclosures/resume-disclosure.service";
import {
  PayerRequestDisclosureSchema,
  type PayerRequestDisclosureDto,
} from "./payer-disclosure.dto";

/**
 * Payer-SELF masked-resume disclosure surface (ADR-0019 Phase 1 — closes the F-7 / LC-A
 * launch gate for the resume-disclosure path; the payer analogue of {@link
 * PayerUnlocksController}/{@link PayerReachController}).
 *
 * A NEW route group under `/payer/resume-disclosures`, gated by {@link PayerAuthGuard},
 * DISTINCT from the ops `/resume-disclosures` routes (InternalServiceGuard) which stay
 * for ops-run support — one principal per route, never conflated. The `payer_id` is the
 * caller's OWN id **derived from the verified session** (`req.payer.id`); the body never
 * carries a `payer_id` (XB-A). It REUSES the {@link ResumeDisclosureService} chokepoint
 * UNCHANGED — the fail-closed ordering (consent → shared cap → grant → single decrypt at
 * render), the identity masking, the no-oracle neutral body, and the PII-free
 * `resume.disclosed` event. Tenancy is inherent: every call is keyed on the session
 * `payer_id`, so a payer can only request/list its OWN disclosures.
 *
 * A per-PAYER hourly cap (XB-G, {@link PayerDisclosureRateLimit}) throttles harvest
 * velocity BEFORE the chokepoint — the same shared limiter the unlock/reveal path uses.
 * There is intentionally NO bulk route (B-F anti-harvest): one (payer, worker, posting)
 * per request.
 *
 * SECURITY GATE: external untrusted boundary — a `bb-security-review` PASS is required
 * before merge. Disclosure is FREE (no credit/payment) and masked (no raw PII ever
 * leaves the boundary; the real name is read once server-side at render only).
 */
@Controller("payer/resume-disclosures")
@UseGuards(PayerAuthGuard)
export class PayerDisclosureController {
  constructor(
    private readonly disclosures: ResumeDisclosureService,
    private readonly disclosureRate: PayerDisclosureRateLimit,
  ) {}

  /**
   * Request the identity-MASKED resume for one worker the caller is entitled to. The
   * `payer_id` is the SESSION payer — never a body value (XB-A). Returns the ONE
   * distinguishable success `{ ok, disclosure_id, status, resume_url, expires_at }` or
   * the byte-identical neutral body for EVERY deny branch (no_consent / capped / unknown
   * / no-resume / render-unavailable). HTTP 200 in all cases — the status is not an
   * oracle (B-C). The response NEVER contains a name, a phone, or the deny reason.
   */
  @Post()
  @HttpCode(200)
  async request(
    @Body(new ZodValidationPipe(PayerRequestDisclosureSchema)) dto: PayerRequestDisclosureDto,
    @CurrentPayer() payer: AuthenticatedPayer,
    @Ctx() ctx: RequestContext,
  ) {
    await this.disclosureRate.assertWithinHourlyCap(payer.id); // XB-G (real identity)
    return this.disclosures.requestDisclosure(
      { payerId: payer.id, workerId: dto.worker_id, jobPostingId: dto.job_posting_id },
      ctx,
    );
  }

  /** List the caller's OWN disclosures (scoped to the session `payer_id`; PII-free projection). */
  @Get()
  listOwn(@CurrentPayer() payer: AuthenticatedPayer) {
    return this.disclosures.listByPayer(payer.id);
  }
}
