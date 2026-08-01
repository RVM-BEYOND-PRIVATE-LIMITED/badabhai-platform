import { Controller, Get, Headers, Inject, Ip, Param, Redirect } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import { ReferralLinkService } from "./referral-link.service";
import { fallbackTarget } from "./referral-resolve";

/**
 * `GET /r/:code` — THE REFERRAL RESOLVER (B4). The single entry point every agent code,
 * worker share, campaign URL and QR code goes through.
 *
 * PUBLIC AND UNAUTHENTICATED BY DESIGN: the person clicking a shared link has no session,
 * and demanding one is precisely the defect that made invited workers unattributable
 * (TD113, fixed for the legacy click path in `MessagingController` — this route inherits
 * the same posture rather than reintroducing a gate).
 *
 * IT ALWAYS REDIRECTS. There is no error branch: a malformed code, an unknown code, an
 * expired link and a database outage all 302 to the install page. "A shared link should
 * never dead-end" is the requirement, and the only way to honour it is to make the failure
 * path a redirect rather than a status code.
 *
 * NO ORACLE. Valid, invalid, expired and already-claimed codes are indistinguishable from
 * the outside: same status, same shape of destination, no body. This URL is completely
 * unauthenticated and goes on QR codes at factory gates — an attacker who could tell a live
 * code from a dead one could enumerate the referral space and harvest commissions.
 *
 * RATE LIMIT: per-IP hourly cap, sharing the `invite_click` bucket and cap with the legacy
 * click path — the two are the same funnel action and must not be separately budgeted. A
 * breach SHEDS THE CLICK WRITE and still redirects, for the same reason as the legacy path:
 * over-capping must degrade a statistic, never a worker standing at a factory gate.
 *
 * 302, NOT 301. A permanent redirect would be cached by the browser and the click would
 * stop reaching us on every subsequent tap — silently zeroing the funnel.
 */
@Controller("r")
export class ReferralResolverController {
  constructor(
    private readonly links: ReferralLinkService,
    private readonly ipRateLimit: IpRateLimit,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  @Get(":code")
  @Redirect(undefined, 302)
  async resolve(
    @Param("code") code: string,
    @Ip() ip: string,
    @Headers("user-agent") userAgent: string | undefined,
  ): Promise<{ url: string; statusCode: number }> {
    // The code is NOT validated by a pipe here on purpose: a ZodValidationPipe would 400 on
    // a malformed code, which is exactly the dead-end this route must not produce. Shape is
    // checked inside the service, which degrades to the fallback redirect instead.
    let skipClick = false;
    try {
      await this.ipRateLimit.assertWithinHourlyIpCap(
        "invite_click",
        ip ?? "unknown",
        this.config.REFERRAL_CLICK_MAX_PER_IP_PER_HOUR,
      );
    } catch {
      // Over cap (or Redis down → fail-closed). Shed the click WRITE only — the redirect
      // still carries the code, so the Play Store referrer still attributes the install.
      // Dropping the code here would punish a whole factory gate for sharing one egress IP.
      skipClick = true;
    }

    try {
      const outcome = await this.links.resolve({ code, ip, userAgent, skipClick });
      return { url: outcome.redirectTo, statusCode: 302 };
    } catch {
      // The service is fail-safe internally; this is the last-resort belt so that no
      // unforeseen throw can turn a shared link into a 500.
      return { url: fallbackTarget(this.config.REFERRAL_SHORT_LINK_BASE), statusCode: 302 };
    }
  }
}
