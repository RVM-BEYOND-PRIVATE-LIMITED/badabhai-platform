import { Body, Controller, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { WorkerAuthGuard, CurrentWorker, type AuthenticatedWorker } from "../auth/worker-auth.guard";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { InviteService } from "./invite.service";
import { InviteClickService } from "./invite-click.service";
import { ReengagementService } from "./reengagement.service";
import {
  CreateInviteSchema,
  InviteCodeParamSchema,
  ReengageSchema,
  type CreateInviteDto,
  type InviteCodeParam,
  type ReengageDto,
} from "./messaging.dto";

/**
 * WhatsApp invite funnel + re-engagement HTTP surface (ADR-0020). Thin — all logic +
 * the consent gate + event emission live in the services. Responses are PII-free.
 *
 * - `POST /invites` is WORKER-authed: a worker mints their OWN referral link (sharing
 *   it is the worker's act — no messaging consent needed to create a link).
 * - `POST /invites/:code/click` is public attribution (PII-free; neutral on unknown) and,
 *   since TD113, the ONE worker-reachable click path for BOTH funnels — an unknown worker
 *   code falls through to the agency code space (see {@link InviteClickService}).
 * - `POST /messaging/reengage` is ops/system (InternalServiceGuard) — the send itself
 *   is consent-gated fail-closed inside the service (mock provider in alpha).
 */
@Controller()
export class MessagingController {
  constructor(
    private readonly invites: InviteService,
    private readonly clicks: InviteClickService,
    private readonly reengagement: ReengagementService,
  ) {}

  @Post("invites")
  @UseGuards(WorkerAuthGuard)
  createInvite(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(CreateInviteSchema)) dto: CreateInviteDto,
  ) {
    return this.invites.createInvite(worker.id, dto.campaign);
  }

  /**
   * PUBLIC click attribution for BOTH referral funnels (TD113). No guard by design: the
   * invited worker clicks a shared link before they have any session at all.
   *
   * NO-ORACLE: the response is the CONSTANT `{ ok: true }` for a valid worker code, a valid
   * agency code, and a code that exists in neither — the previous body echoed the worker
   * table's hit/miss (`{ok:false}` on unknown), which was an existence oracle on an
   * unauthenticated route. The service is fail-safe, so an internal error does not become a
   * distinguishable 500 either.
   */
  @Post("invites/:code/click")
  @HttpCode(200)
  async recordClick(
    @Param(new ZodValidationPipe(InviteCodeParamSchema)) params: InviteCodeParam,
  ): Promise<{ ok: true }> {
    await this.clicks.recordPublicClick(params.code);
    return { ok: true };
  }

  @Post("messaging/reengage")
  @HttpCode(200)
  @UseGuards(InternalServiceGuard)
  reengage(@Body(new ZodValidationPipe(ReengageSchema)) dto: ReengageDto) {
    return this.reengagement.sendReengagement(dto.worker_id, dto.template);
  }
}
