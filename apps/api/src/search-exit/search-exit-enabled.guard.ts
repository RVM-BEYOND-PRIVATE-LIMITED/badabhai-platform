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
import { searchExitEnabled } from "./search-exit.flag";

/**
 * Launch gate for `workers/me/search-visibility` (#2753 item 6). While `SEARCH_EXIT_ENABLED` is
 * off, both routes answer the SAME 404 Nest gives a route that does not exist
 * (`Cannot GET /workers/me/search-visibility`), so the wire is byte-identical to before the
 * routes shipped.
 *
 * FIRST IN THE GUARD CHAIN, before `WorkerAuthGuard`, on purpose (the `CampusServiceGuard` order):
 * off, nothing runs at all, no token verification, no consent read and no table read. On, the
 * worker guards run as on every other `workers/me/*` route.
 */
@Injectable()
export class SearchExitEnabledGuard implements CanActivate {
  constructor(@Inject(SERVER_CONFIG) private readonly config: ServerConfig) {}

  canActivate(context: ExecutionContext): boolean {
    if (!searchExitEnabled(this.config)) {
      const req = context.switchToHttp().getRequest<Request>();
      throw new NotFoundException(`Cannot ${req.method} ${req.originalUrl}`);
    }
    return true;
  }
}
