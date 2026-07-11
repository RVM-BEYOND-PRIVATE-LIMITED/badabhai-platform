import { Controller, Get, Inject, Ip, NotFoundException, Param } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import { INTERVIEW_KITS, getInterviewKit } from "./interview-kit-content";
import {
  TradeKeyParamSchema,
  type InterviewKitContent,
  type InterviewKitListResponse,
} from "./interview-kit.dto";

/**
 * Interview-kit READ routes (TD54) — the JSON companions to the existing PDF route
 * on the singular `interview-kit` controller. The client contract is PLURAL:
 * `GET /interview-kits` (list) and `GET /interview-kits/:tradeKey` (full kit).
 *
 * POSTURE (mirrors the download route exactly): UNAUTHENTICATED — kit content is
 * per-TRADE and PII-FREE by construction — but per-IP rate-limited FIRST on every
 * route (TD24), drawing on the SAME "interview_kit" bucket as the PDF download route
 * so the whole interview-kit surface shares one per-IP hourly budget.
 *
 * NO EVENTS — decided explicitly against CLAUDE.md invariant §1: these are read-only
 * serves of static per-trade content, not a material state change; the usage signal
 * for this surface remains `interview_kit.downloaded` on the PDF download path.
 */
@Controller("interview-kits")
export class InterviewKitsController {
  constructor(
    private readonly ipRateLimit: IpRateLimit,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /** List the wired kits — `{ kits: [{ trade_key, display_name }] }`. 429 over the per-IP cap. */
  @Get()
  async list(@Ip() ip: string): Promise<InterviewKitListResponse> {
    // Shared "interview_kit" per-IP bucket with the PDF download route (one budget).
    await this.ipRateLimit.assertWithinHourlyIpCap(
      "interview_kit",
      ip,
      this.config.INTERVIEW_KIT_RATE_LIMIT_PER_IP_PER_HOUR,
    );
    // Intentionally reads INTERVIEW_KITS ONLY — the 15 wired manufacturing kits.
    // Draft sets that are NOT wired for serving (e.g. HOSPITALITY_INTERVIEW_KITS in
    // hospitality-interview-kit-content.ts) are never imported here, so an unwired
    // draft can never leak through this list.
    return {
      kits: INTERVIEW_KITS.map((k) => ({
        trade_key: k.trade_key,
        display_name: k.display_name,
      })),
    };
  }

  /** Full static kit JSON for one trade. 404 unknown trade · 429 over the per-IP cap. */
  @Get(":tradeKey")
  async detail(
    @Param("tradeKey", new ZodValidationPipe(TradeKeyParamSchema)) tradeKey: string,
    @Ip() ip: string,
  ): Promise<InterviewKitContent> {
    // Shared "interview_kit" per-IP bucket with the PDF download route (one budget).
    await this.ipRateLimit.assertWithinHourlyIpCap(
      "interview_kit",
      ip,
      this.config.INTERVIEW_KIT_RATE_LIMIT_PER_IP_PER_HOUR,
    );
    const kit = getInterviewKit(tradeKey);
    // Static, PII-free message — never echo the requested key back.
    if (!kit) throw new NotFoundException("Interview kit not found for this trade");
    return kit;
  }
}
