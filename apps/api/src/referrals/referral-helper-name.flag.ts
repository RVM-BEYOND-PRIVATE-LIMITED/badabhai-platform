import type { ServerConfig } from "@badabhai/config";

/** The one config key the helper's-name route reads. */
export type ReferralHelperNameConfig = Pick<ServerConfig, "REFERRAL_HELPER_NAME_ENABLED">;

/**
 * `REFERRAL_HELPER_NAME_ENABLED` (#2753 item 12) — THE ONE READ of the flag. Only `true` turns it
 * on; unset, empty and a missing config object are off, so a caller that was never handed the
 * config fails closed to today's rule: no code tells anyone who invited them.
 *
 * OWNER APPROVAL BEFORE IT GOES ON. On, `GET /referrals/helper` tells anyone holding an agency
 * code that agency's company name, before sign-in: it reverses the no-oracle rule of
 * `POST /referrals/attribute`. The screen's copy waits for a lawyer's check too: "[Name] helped
 * you make this profile. Confirm with the OTP only if the details are yours and you have not paid
 * anyone."
 */
export function referralHelperNameEnabled(config: ReferralHelperNameConfig | undefined): boolean {
  return config?.REFERRAL_HELPER_NAME_ENABLED === true;
}
