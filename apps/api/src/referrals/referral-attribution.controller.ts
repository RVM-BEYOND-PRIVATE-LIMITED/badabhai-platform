import { Body, Controller, HttpCode, Inject, Ip, Post, UseGuards } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { ReferralAttributionService } from "./referral-attribution.service";
import { AttributeReferralSchema, type AttributeReferralDto } from "./referral-attribution.dto";

/**
 * Referral attribution surface — the worker-onboarding hook that closes the ADR-0020 /
 * ADR-0022 loop. The worker app calls this AFTER consent, passing the opaque invite code
 * captured from the `/i/<code>` deep-link that brought the worker in.
 *
 * AUTH: {@link WorkerAuthGuard} — the `invited_worker_id` is ALWAYS the verified SESSION
 * worker (`@CurrentWorker`), never a body id, so a caller can only ever attribute
 * THEMSELVES to a code (anti-abuse; the XB-A "id from session, not body" rule).
 * CONSENT: enforced fail-closed in the service (invariant #6).
 * RATE LIMIT: per-IP hourly cap (fail-closed via {@link IpRateLimit}) — a low-frequency
 * onboarding action; the cap blunts DB-load abuse + timing brute-force of the code space.
 * NO-ORACLE: the attribution runs FIRE-AND-FORGET (not awaited) and the response is a
 * constant-time neutral `{ ok: true }` REGARDLESS of whether the code matched, was
 * self/duplicate, or attribution occurred — so a worker can neither learn a code's
 * validity / who invited them (body oracle) nor infer it from response latency (timing
 * oracle). Attribution is a best-effort side-signal; the service also never throws.
 */
@Controller("referrals")
export class ReferralAttributionController {
  constructor(
    private readonly attribution: ReferralAttributionService,
    private readonly ipRateLimit: IpRateLimit,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  @Post("attribute")
  @HttpCode(200)
  @UseGuards(WorkerAuthGuard)
  async attribute(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(AttributeReferralSchema)) dto: AttributeReferralDto,
    @Ip() ip: string,
  ): Promise<{ ok: true }> {
    await this.ipRateLimit.assertWithinHourlyIpCap(
      "referral_attribute",
      ip ?? "unknown",
      this.config.REFERRAL_ATTRIBUTE_MAX_PER_IP_PER_HOUR,
    );
    // FIRE-AND-FORGET best-effort side-signal: not awaited, so the response is constant-time
    // (no timing oracle) and attribution can never delay/break onboarding. The service is
    // internally fail-safe (never throws); the `.catch` is belt-and-braces against an
    // unhandled rejection. We ignore the internal outcome and always return the same body.
    void this.attribution.attribute(dto.code, worker.id).catch(() => undefined);
    return { ok: true };
  }
}
