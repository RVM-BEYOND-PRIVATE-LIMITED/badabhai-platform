import { type CanActivate, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";

/**
 * `FLOW_CHECK_ENABLED` (#2890) as a route gate: a neutral 404 while the switch is off, Nest's bare
 * `NotFoundException` with no "disabled" wording, before any pipe, query or event.
 *
 * On the admin read it runs AFTER `AdminAuthGuard` (an unauthenticated caller gets the 401 every
 * `/admin/*` route gives) and BEFORE `AdminRolesGuard`, so while off every role gets the same 404
 * (the numbers screen's ordering). On Campus's report it runs after `CampusServiceGuard`, which
 * already answers 404 while the Campus link itself is off.
 */
@Injectable()
export class FlowCheckEnabledGuard implements CanActivate {
  constructor(
    @Inject(SERVER_CONFIG) private readonly config: Pick<ServerConfig, "FLOW_CHECK_ENABLED">,
  ) {}

  canActivate(): boolean {
    if (this.config?.FLOW_CHECK_ENABLED !== true) throw new NotFoundException();
    return true;
  }
}
