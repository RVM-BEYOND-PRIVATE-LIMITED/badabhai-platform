import { type CanActivate, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../../config/config.module";

/** The one config key the numbers screen reads. */
export type AdminNumbersConfig = Pick<ServerConfig, "ADMIN_NUMBERS_ENABLED">;

/**
 * `ADMIN_NUMBERS_ENABLED` (#2755 item 13) — THE ONE READ of the switch. Every `/admin/numbers/*`
 * route asks here through {@link AdminNumbersEnabledGuard}, so "on" cannot mean two things. Only
 * `true` turns it on; unset, empty and a missing config object are off.
 */
export function adminNumbersEnabled(config: AdminNumbersConfig | undefined): boolean {
  return config?.ADMIN_NUMBERS_ENABLED === true;
}

/**
 * The numbers routes' launch gate: a neutral 404 while the switch is off — Nest's bare
 * `NotFoundException` body, with no "disabled" wording. It runs AFTER `AdminAuthGuard` (an
 * unauthenticated caller gets the 401 every `/admin/*` route gives) and BEFORE `AdminRolesGuard`,
 * so while off every role gets the same 404 rather than some a 403 (the `AdminAiTraceFlagGuard`
 * ordering). It runs before any pipe or the service, so a disabled route touches no table.
 */
@Injectable()
export class AdminNumbersEnabledGuard implements CanActivate {
  constructor(@Inject(SERVER_CONFIG) private readonly config: AdminNumbersConfig) {}

  canActivate(): boolean {
    if (!adminNumbersEnabled(this.config)) throw new NotFoundException();
    return true;
  }
}

/** The owner's "a few days after it ends" (#2755 item 4): a week freezes 3 days after its Sunday. */
export const DEFAULT_NUMBERS_FREEZE_AFTER_DAYS = 3;

/**
 * `NUMBERS_FREEZE_AFTER_DAYS` — how many whole days after a week ends the sweep freezes it, or the
 * default when the config does not carry a valid one (a hand-built config in a test or a CLI).
 */
export function numbersFreezeAfterDays(
  config: Pick<ServerConfig, "NUMBERS_FREEZE_AFTER_DAYS"> | undefined,
): number {
  const days = config?.NUMBERS_FREEZE_AFTER_DAYS;
  return typeof days === "number" && Number.isInteger(days) && days >= 1
    ? days
    : DEFAULT_NUMBERS_FREEZE_AFTER_DAYS;
}
