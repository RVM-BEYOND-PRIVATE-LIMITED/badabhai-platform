import { Controller, Get, Header, Inject, Query } from "@nestjs/common";

import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import { APP_CONFIG_CACHE_SECONDS } from "./app-version.constants";
import { AppConfigQuerySchema, type AppConfigQueryDto } from "./app-version.dto";
import { AppVersionService, type AppConfigView } from "./app-version.service";

/**
 * #3048 — the apps' start-up check (#3049).
 *
 *   GET /app-config?app=worker|payer&platform=android|ios
 *     → { app, platform, min_supported_build, latest_build, store_url, message_key }
 *
 * PUBLIC AND UNAUTHENTICATED by design: the app asks before anyone signs in, and the answer is
 * the same for every caller (closed values, integers, a public store link; no personal data). It
 * emits no event — a read, not a business action. Cacheable for five minutes. A read error
 * answers 503, which the apps treat as "let the user in".
 */
@Controller("app-config")
export class AppConfigController {
  // Explicit @Inject: the HTTP contract test boots this controller under vitest.
  constructor(@Inject(AppVersionService) private readonly policy: AppVersionService) {}

  @Get()
  @Header("Cache-Control", `public, max-age=${APP_CONFIG_CACHE_SECONDS}`)
  async getConfig(
    @Query(new ZodValidationPipe(AppConfigQuerySchema)) query: AppConfigQueryDto,
  ): Promise<AppConfigView> {
    return this.policy.getConfig(query.app, query.platform);
  }
}
