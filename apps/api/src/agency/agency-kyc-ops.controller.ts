import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { AgencyKycService } from "./agency-kyc.service";
import {
  OpsAgencyKycParamSchema,
  OpsRejectAgencyKycSchema,
  type OpsRejectAgencyKycDto,
} from "./agency-kyc-ops.dto";

/**
 * OPS-facing agency-KYC verify queue (ADR-0022 Amendment 2) — the apps/web ops console surface.
 *
 * Gated by {@link InternalServiceGuard} (the shared `INTERNAL_SERVICE_TOKEN` the ops console
 * attaches server-side), matching the existing ops routes (`/pricing`, `/unlocks`, `/workers`) —
 * NOT the payer-facing guards, and one principal per route. FINANCIAL-PII SAFE: the list is
 * MASKED (last-4 only) exactly like the agency's own view; there is NO endpoint that returns the
 * full PAN/bank to anyone. Verify is a MOCK human ack (no real registry check — real verification
 * is the legal/§7 launch gate). Verify/reject emit `agency_kyc.verified`/`.rejected` (actor `ops`).
 */
@Controller("ops/agency-kyc")
@UseGuards(InternalServiceGuard)
export class AgencyKycOpsController {
  constructor(private readonly kyc: AgencyKycService) {}

  /** The pending-verification queue, masked (last-4 only). */
  @Get("pending")
  listPending() {
    return this.kyc.listPendingForOps();
  }

  /** Verify an agency's KYC (pending → verified). Idempotent no-op if not pending. */
  @Post(":payerId/verify")
  @HttpCode(200)
  verify(@Param(new ZodValidationPipe(OpsAgencyKycParamSchema)) params: { payerId: string }) {
    return this.kyc.verify(params.payerId);
  }

  /** Reject an agency's KYC with a bounded reason CODE (pending → rejected). */
  @Post(":payerId/reject")
  @HttpCode(200)
  reject(
    @Param(new ZodValidationPipe(OpsAgencyKycParamSchema)) params: { payerId: string },
    @Body(new ZodValidationPipe(OpsRejectAgencyKycSchema)) body: OpsRejectAgencyKycDto,
  ) {
    return this.kyc.reject(params.payerId, body.reason);
  }
}
