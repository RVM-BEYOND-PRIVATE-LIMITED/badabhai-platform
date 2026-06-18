import { Body, Controller, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { WorkerAuthGuard, CurrentWorker, type AuthenticatedWorker } from "../auth/worker-auth.guard";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { InviteService } from "./invite.service";
import { ReengagementService } from "./reengagement.service";
import { CreateInviteSchema, ReengageSchema, type CreateInviteDto, type ReengageDto } from "./messaging.dto";

/**
 * WhatsApp invite funnel + re-engagement HTTP surface (ADR-0020). Thin — all logic +
 * the consent gate + event emission live in the services. Responses are PII-free.
 *
 * - `POST /invites` is WORKER-authed: a worker mints their OWN referral link (sharing
 *   it is the worker's act — no messaging consent needed to create a link).
 * - `POST /invites/:code/click` is public attribution (PII-free; neutral on unknown).
 * - `POST /messaging/reengage` is ops/system (InternalServiceGuard) — the send itself
 *   is consent-gated fail-closed inside the service (mock provider in alpha).
 */
@Controller()
export class MessagingController {
  constructor(
    private readonly invites: InviteService,
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

  @Post("invites/:code/click")
  @HttpCode(200)
  recordClick(@Param("code") code: string) {
    return this.invites.recordClick(code);
  }

  @Post("messaging/reengage")
  @HttpCode(200)
  @UseGuards(InternalServiceGuard)
  reengage(@Body(new ZodValidationPipe(ReengageSchema)) dto: ReengageDto) {
    return this.reengagement.sendReengagement(dto.worker_id, dto.template);
  }
}
