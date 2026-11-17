import { type CanActivate, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";

/** The one config key hire records read. */
export type HireRecordsConfig = Pick<ServerConfig, "HIRE_RECORDS_ENABLED">;

/**
 * `HIRE_RECORDS_ENABLED` (#2753 item 9) — THE ONE READ of the switch. The stage transaction's hire
 * source, `HiresService` and the admin list's guard all ask here, so "on" cannot mean two things.
 * Only `true` turns it on; unset, empty and a missing config object are off.
 *
 * OFF IS TODAY'S API EXACTLY, and NOTHING names `hires`: that is what lets a build reach a database
 * that has not applied the migration without one failed query.
 */
export function hireRecordsEnabled(config: HireRecordsConfig | undefined): boolean {
  return config?.HIRE_RECORDS_ENABLED === true;
}

/**
 * `GET /admin/hires`'s launch gate: a neutral 404 while the switch is off — Nest's bare
 * `NotFoundException` body, with no "disabled" wording. It runs AFTER `AdminAuthGuard` (an
 * unauthenticated caller gets the 401 every `/admin/*` route gives) and BEFORE `AdminRolesGuard`,
 * so while off every role gets the same 404 rather than some a 403 (the `AdminAiTraceFlagGuard`
 * ordering). It runs before any pipe or the service, so a disabled route touches no table.
 */
@Injectable()
export class HireRecordsEnabledGuard implements CanActivate {
  constructor(@Inject(SERVER_CONFIG) private readonly config: HireRecordsConfig) {}

  canActivate(): boolean {
    if (!hireRecordsEnabled(this.config)) throw new NotFoundException();
    return true;
  }
}
