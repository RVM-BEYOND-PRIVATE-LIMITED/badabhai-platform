import { type CanActivate, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";

/** The one config key the payer applicant pipeline board reads. */
export type ApplicantStagesConfig = Pick<ServerConfig, "PAYER_APPLICANT_STAGES_ENABLED">;

/**
 * `PAYER_APPLICANT_STAGES_ENABLED` (owner ruling 2026-10-07) — THE ONE READ of the flag. The
 * stage route's guard, the inbox query pipe, the inbox service and the stages service all ask
 * here, so "on" cannot mean two things. Only `true` turns it on; unset and empty are off.
 *
 * OFF IS TODAY'S API EXACTLY, and NOTHING names `payer_applicant_stages` (migration 0134): that is
 * what lets a build reach a database that has not applied the migration without one failed query.
 */
export function applicantStagesEnabled(config: ApplicantStagesConfig): boolean {
  return config.PAYER_APPLICANT_STAGES_ENABLED === true;
}

/**
 * The stage route's launch gate: a NEUTRAL 404 while the flag is off, indistinguishable from a
 * route that does not exist (the `AgencyPayoutsEnabledGuard` shape). Listed AFTER
 * `PayerAuthGuard`, so an unauthenticated caller still gets the 401 every `/payer/*` route gives,
 * and BEFORE any pipe, the rate limit or the service, so a disabled route costs no Redis unit and
 * touches no table.
 */
@Injectable()
export class PayerApplicantStagesEnabledGuard implements CanActivate {
  constructor(@Inject(SERVER_CONFIG) private readonly config: ApplicantStagesConfig) {}

  canActivate(): boolean {
    if (!applicantStagesEnabled(this.config)) throw new NotFoundException();
    return true;
  }
}
