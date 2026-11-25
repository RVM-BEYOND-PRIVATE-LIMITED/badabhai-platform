import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { AppConfigController } from "./app-config.controller";
import { AppVersionRepository } from "./app-version.repository";
import { AppVersionService } from "./app-version.service";
import { MinAppBuildGuard } from "./min-app-build.guard";

/**
 * #3048 — the minimum supported app build.
 *
 *  - `GET /app-config` (public) — the apps' start-up check.
 *  - {@link MinAppBuildGuard} under `APP_GUARD` — GLOBAL by virtue of the token (not by being in
 *    this module): a write from a build below the minimum gets 426 on every route.
 *  - Exports {@link AppVersionService} for the admin GET/PUT (`/admin/app-release-policy`).
 *
 * DATABASE and EventsService come from global modules. Imports nothing, so no cycle.
 */
@Module({
  controllers: [AppConfigController],
  providers: [
    AppVersionRepository,
    AppVersionService,
    { provide: APP_GUARD, useClass: MinAppBuildGuard },
  ],
  exports: [AppVersionService],
})
export class AppVersionModule {}
