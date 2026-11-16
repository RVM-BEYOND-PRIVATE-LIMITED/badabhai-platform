import { type CanActivate, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";

import { SERVER_CONFIG } from "../config/config.module";

/**
 * `PAY_ON_JOINING_RECORDS_ENABLED` (#2753 item 11) — a NEUTRAL 404 for every caller while it is
 * off, before any query: nothing reads or writes `pay_on_joining_hires` with the switch off.
 *
 * A GUARD, ORDERED BETWEEN AUTH AND ROLES, for the reason `AdminAiTraceFlagGuard` gives: as an `if`
 * in a handler, `AdminRolesGuard` would run first and answer a support or analyst admin `403`,
 * telling them the route exists. In `@UseGuards(AdminAuthGuard, PayOnJoiningFlagGuard,
 * AdminRolesGuard)`: no session is `401`, a closed switch is `404` for every role alike, and only
 * an open switch reaches the capability check. This guard reads one boolean and no role.
 */
@Injectable()
export class PayOnJoiningFlagGuard implements CanActivate {
  constructor(@Inject(SERVER_CONFIG) private readonly config: ServerConfig) {}

  canActivate(): boolean {
    if (this.config.PAY_ON_JOINING_RECORDS_ENABLED !== true)
      throw new NotFoundException("Not found");
    return true;
  }
}
