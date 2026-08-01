import { Body, Controller, HttpCode, Inject, Ip, Param, Post, UseGuards } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { InternalServiceGuard } from "../common/guards/internal-service.guard";
import { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
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
    private readonly ipRateLimit: IpRateLimit,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
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
   * agency code, a code that exists in neither, an internal error, AND a rate-limit breach —
   * the previous body echoed the worker table's hit/miss (`{ok:false}` on unknown), which
   * was an existence oracle on an unauthenticated route.
   *
   * RATE LIMIT (B4): per-IP, rolling UTC hour, via the shared {@link IpRateLimit} — this URL
   * goes on QR codes at factory gates and to ~450 agents, making it the most-scanned
   * unauthenticated endpoint we own, and uncapped it is a free amplifier for burning DB
   * time. A breach does NOT surface as a 429: we SHED THE WORK and return the same neutral
   * body, because
   *   (a) a distinguishable status on this route is exactly the oracle shape just removed,
   *       and
   *   (b) a cap breach here costs a funnel STATISTIC, never a worker's install page — and
   *       `IpRateLimit` fails CLOSED on a Redis outage, which must likewise degrade the
   *       stat rather than 429 someone standing at a factory gate.
   *
   * CAVEAT (deploy-time, not code): the `/i/<code>` landing page pings this SERVER-SIDE, so
   * with `TRUST_PROXY_HOP_COUNT=0` (the default) every legitimate scan shares payer-web's
   * single egress IP and lands in ONE bucket — hence the deliberately high default cap. Set
   * TRUST_PROXY_HOP_COUNT to the real edge hop count to make the cap per-visitor. It is NOT
   * set here and payer-web deliberately does NOT forward an X-Forwarded-For of its own:
   * doing so while the hop count is unknown would hand an abuser a spoofable, rotatable
   * rate-limit identity, which is worse than one coarse bucket (TD25 note in config).
   */
  @Post("invites/:code/click")
  @HttpCode(200)
  async recordClick(
    @Param(new ZodValidationPipe(InviteCodeParamSchema)) params: InviteCodeParam,
    @Ip() ip: string,
  ): Promise<{ ok: true }> {
    try {
      await this.ipRateLimit.assertWithinHourlyIpCap(
        "invite_click",
        ip ?? "unknown",
        this.config.REFERRAL_CLICK_MAX_PER_IP_PER_HOUR,
      );
    } catch {
      // Over cap (or Redis down → fail-closed). Drop the work, keep the response identical.
      return { ok: true };
    }
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
