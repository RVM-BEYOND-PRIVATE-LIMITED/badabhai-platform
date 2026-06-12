import { Controller, Get, Inject, Ip, Param, Query } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import { InterviewKitService } from "./interview-kit.service";
import { TradeKeyParamSchema, KitSourceSchema, type KitSourceDto } from "./interview-kit.dto";

/**
 * Per-trade interview kit (Task 4). Content is PII-FREE (per-trade, not per-worker),
 * so these routes need no internal-service token — but they DO mint signed URLs and
 * can trigger a first render, so they are per-IP rate-limited (TD24). The download
 * route returns a short-lived signed URL to the PRIVATE bucket, never a public path.
 */
@Controller("interview-kit")
export class InterviewKitController {
  constructor(
    private readonly kits: InterviewKitService,
    private readonly ipRateLimit: IpRateLimit,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /**
   * Mint a signed download URL for a trade's interview kit (render-once). Emits
   * `interview_kit.downloaded` (and `interview_kit.render_completed` on first render).
   * 404 unknown trade · 429 over the per-IP hourly cap · 503 while unavailable.
   */
  @Get(":tradeKey/download")
  async download(
    @Param("tradeKey", new ZodValidationPipe(TradeKeyParamSchema)) tradeKey: string,
    @Query("source", new ZodValidationPipe(KitSourceSchema)) source: KitSourceDto,
    @Ip() ip: string,
    @Ctx() ctx: RequestContext,
  ) {
    await this.ipRateLimit.assertWithinHourlyIpCap(
      "interview_kit",
      ip,
      this.config.INTERVIEW_KIT_RATE_LIMIT_PER_IP_PER_HOUR,
    );
    return this.kits.getDownload(tradeKey, ctx, { source });
  }
}
