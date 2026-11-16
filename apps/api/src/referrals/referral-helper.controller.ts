import { Controller, Get, Header, Inject, Ip, NotFoundException, Query } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import { referralHelperNameEnabled } from "./referral-helper-name.flag";
import { ReferralHelperNameService } from "./referral-helper-name.service";

/** The body of `GET /referrals/helper`, the same shape for a name and for every null. */
export interface ReferralHelperResponse {
  display_name: string | null;
}

/**
 * `GET /referrals/helper?code=<code>` — the helper's name for the worker app's pre-code screen
 * (#2753 item 12, brief 9): "[Name] helped you make this profile. Confirm with the OTP only if the
 * details are yours and you have not paid anyone." (That copy is still to be checked by a lawyer.)
 *
 * ⚠ OWNER APPROVAL BEFORE `REFERRAL_HELPER_NAME_ENABLED` GOES ON. This route reverses the rule
 * `POST /referrals/attribute` was built on (a worker learns neither whether a code is valid nor
 * who invited him) and opens a code-to-name lookup to anyone, before sign-in. What limits it:
 *   - OFF (the default): a neutral 404 before the rate limiter, the database or any name is read.
 *   - ON: only an agency's COMPANY name, for a live agency code. A worker referrer's code, an
 *     unknown, expired, spent or malformed code, and any failure are all the SAME 200 body,
 *     `{ "display_name": null }`, from the same one query, so the status and the body are no
 *     oracle beyond the name itself. A worker's stored name, phone or anything else never leaves.
 *   - PER-ADDRESS CAP: the limiter and the cap of `POST /referrals/attribute`
 *     (`REFERRAL_ATTRIBUTE_MAX_PER_IP_PER_HOUR`, fail closed), in its own `referral_helper`
 *     bucket, so probing names does not spend a worker's attribution budget or the reverse.
 *   - `Cache-Control: no-store`: a name for a bearer code is not kept by any cache on the way.
 *
 * UNAUTHENTICATED BY DESIGN: the screen comes before the OTP, so there is no session to require.
 * The code is read raw (no validation pipe): a malformed code must answer the null body, not a 400.
 */
@Controller("referrals")
export class ReferralHelperController {
  constructor(
    private readonly helperName: ReferralHelperNameService,
    private readonly ipRateLimit: IpRateLimit,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  @Get("helper")
  @Header("Cache-Control", "no-store")
  async helper(@Query("code") code: unknown, @Ip() ip: string): Promise<ReferralHelperResponse> {
    if (!referralHelperNameEnabled(this.config)) throw new NotFoundException("Not found");
    await this.ipRateLimit.assertWithinHourlyIpCap(
      "referral_helper",
      ip ?? "unknown",
      this.config.REFERRAL_ATTRIBUTE_MAX_PER_IP_PER_HOUR,
    );
    return { display_name: await this.helperName.displayName(code) };
  }
}
