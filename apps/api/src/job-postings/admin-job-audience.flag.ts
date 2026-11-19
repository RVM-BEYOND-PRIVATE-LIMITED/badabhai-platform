import { type CanActivate, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";

/** The one config key the admin audience control reads. */
export type AdminJobAudienceConfig = Pick<ServerConfig, "ADMIN_JOB_AUDIENCE_ENABLED">;

/**
 * `ADMIN_JOB_AUDIENCE_ENABLED` (#2956) — THE ONE READ of the switch. The admin audience routes ask
 * here through {@link AdminJobAudienceEnabledGuard}, and Campus's review of an admin-sent job asks
 * here too, so "on" cannot mean two things. Only `true` turns it on; unset, empty and a missing
 * config object are off.
 *
 * It gates CAPABILITIES only (R81): whether an admin may set where a job shows, and whether
 * Campus may review a job without the company's `job_audience` pilot. It never decides whether a
 * stored audience or the Campus hold is honoured: every worker and Campus read applies those
 * whatever this says, so turning it off cannot expose a Campus-only job to BadaBhai workers.
 */
export function adminJobAudienceEnabled(config: AdminJobAudienceConfig | undefined): boolean {
  return config?.ADMIN_JOB_AUDIENCE_ENABLED === true;
}

/**
 * The admin audience routes' launch gate: a neutral 404 while the switch is off — Nest's bare
 * `NotFoundException` body, with no "disabled" wording. It runs AFTER `AdminAuthGuard` (an
 * unauthenticated caller gets the 401 every `/admin/*` route gives) and BEFORE `AdminRolesGuard`,
 * so while off every role gets the same 404 rather than some a 403 (the `AdminNumbersEnabledGuard`
 * ordering). It runs before any pipe or the service, so a disabled route touches no table.
 */
@Injectable()
export class AdminJobAudienceEnabledGuard implements CanActivate {
  constructor(@Inject(SERVER_CONFIG) private readonly config: AdminJobAudienceConfig) {}

  canActivate(): boolean {
    if (!adminJobAudienceEnabled(this.config)) throw new NotFoundException();
    return true;
  }
}
