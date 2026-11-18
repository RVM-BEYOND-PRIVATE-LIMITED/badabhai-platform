import { type CanActivate, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";

/** The config keys the company follow-up reads. */
export type UnlockFollowupConfig = Pick<
  ServerConfig,
  "UNLOCK_FOLLOWUP_ENABLED" | "UNLOCK_FOLLOWUP_AFTER_DAYS"
>;

/**
 * `UNLOCK_FOLLOWUP_ENABLED` (#2753 item 10) — THE ONE READ of the switch. The routes' guard and
 * {@link import("./unlock-outcomes.service").UnlockOutcomesService} (the due list, the company's
 * answer and the desk's `not_reached`) all ask here, so "on" cannot mean two things. Only `true`
 * turns it on; unset, empty and a missing config object are off.
 *
 * OFF IS TODAY'S API EXACTLY, and NOTHING names `unlock_outcomes`: that is what lets a build reach a
 * database that has not applied the migration without one failed query.
 */
export function unlockFollowupEnabled(
  config: Pick<ServerConfig, "UNLOCK_FOLLOWUP_ENABLED"> | undefined,
): boolean {
  return config?.UNLOCK_FOLLOWUP_ENABLED === true;
}

/**
 * The follow-up routes' launch gate: a neutral 404 while the switch is off — Nest's bare
 * `NotFoundException` body, with no "disabled" wording, the same body an unlock the company does
 * not own gets. It runs AFTER `PayerAuthGuard` (an unauthenticated caller gets the 401 every
 * `/payer/*` route gives) and before any pipe, the write cap or the service, so a disabled route
 * touches no table and spends nothing.
 */
@Injectable()
export class UnlockFollowupEnabledGuard implements CanActivate {
  constructor(
    @Inject(SERVER_CONFIG) private readonly config: Pick<ServerConfig, "UNLOCK_FOLLOWUP_ENABLED">,
  ) {}

  canActivate(): boolean {
    if (!unlockFollowupEnabled(this.config)) throw new NotFoundException();
    return true;
  }
}
