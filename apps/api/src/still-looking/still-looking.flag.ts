import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { Request } from "express";

import { SERVER_CONFIG } from "../config/config.module";

/** The config keys the monthly check reads. */
export type StillLookingConfig = Pick<
  ServerConfig,
  "STILL_LOOKING_CHECK_ENABLED" | "STILL_LOOKING_PUSH_ENABLED" | "STILL_LOOKING_EVERY_DAYS"
>;

/** "Check every 30 days" (#2753 item 5), the owner's default. */
export const DEFAULT_STILL_LOOKING_EVERY_DAYS = 30;
/** The floor the config enforces, so a typo cannot make the monthly prompt a daily one. */
export const MIN_STILL_LOOKING_EVERY_DAYS = 7;

/**
 * `STILL_LOOKING_CHECK_ENABLED` (#2753 item 5) — THE ONE READ of the switch. Only `true` turns it
 * on; unset, empty and a missing config object are off, so a caller that was never handed the
 * config fails closed to today: no route, no sweep, no read or write of `still_looking_checks`.
 */
export function stillLookingCheckEnabled(
  config: Pick<StillLookingConfig, "STILL_LOOKING_CHECK_ENABLED"> | undefined,
): boolean {
  return config?.STILL_LOOKING_CHECK_ENABLED === true;
}

/**
 * Does the monthly prompt PUSH? Only with BOTH switches on: the check itself
 * (`STILL_LOOKING_CHECK_ENABLED`, without which there is no prompt to push) and the push's own
 * switch (`STILL_LOOKING_PUSH_ENABLED`, default off until the owner widens the ADR-0034 push
 * ruling: this is a non-security push).
 */
export function stillLookingPushEnabled(
  config:
    | Pick<StillLookingConfig, "STILL_LOOKING_CHECK_ENABLED" | "STILL_LOOKING_PUSH_ENABLED">
    | undefined,
): boolean {
  return stillLookingCheckEnabled(config) && config?.STILL_LOOKING_PUSH_ENABLED === true;
}

/** `STILL_LOOKING_EVERY_DAYS`, or the owner's 30 when the config does not carry a valid one. */
export function stillLookingEveryDays(
  config: Pick<StillLookingConfig, "STILL_LOOKING_EVERY_DAYS"> | undefined,
): number {
  const days = config?.STILL_LOOKING_EVERY_DAYS;
  return typeof days === "number" && Number.isInteger(days) && days >= MIN_STILL_LOOKING_EVERY_DAYS
    ? days
    : DEFAULT_STILL_LOOKING_EVERY_DAYS;
}

/**
 * Launch gate for `workers/me/still-looking` (#2753 item 5). While `STILL_LOOKING_CHECK_ENABLED` is
 * off, both routes answer the SAME 404 Nest gives a route that does not exist
 * (`Cannot GET /workers/me/still-looking`), so the wire is byte-identical to before the routes
 * shipped.
 *
 * FIRST IN THE GUARD CHAIN, before `WorkerAuthGuard` (the `SearchExitEnabledGuard` order): off,
 * nothing runs at all, no token verification, no consent read and no table read.
 */
@Injectable()
export class StillLookingEnabledGuard implements CanActivate {
  constructor(
    @Inject(SERVER_CONFIG)
    private readonly config: Pick<StillLookingConfig, "STILL_LOOKING_CHECK_ENABLED">,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!stillLookingCheckEnabled(this.config)) {
      const req = context.switchToHttp().getRequest<Request>();
      throw new NotFoundException(`Cannot ${req.method} ${req.originalUrl}`);
    }
    return true;
  }
}
