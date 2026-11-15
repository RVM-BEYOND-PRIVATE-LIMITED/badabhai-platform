import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { AuthModule } from "../auth/auth.module";
import { FeatureRolloutModule } from "../feature-rollout/feature-rollout.module";
import { PayersModule } from "../payers/payers.module";
import { AdminDisplayPrefsController } from "./admin-display-prefs.controller";
import { DisplayPrefsRepository } from "./display-prefs.repository";
import { DisplayPrefsService } from "./display-prefs.service";
import { PayerDisplayPrefsController } from "./payer-display-prefs.controller";
import { WorkerDisplayPrefsController } from "./worker-display-prefs.controller";

/**
 * #2819 — DISPLAY PREFERENCES: the theme of a worker (`workers/me/display-prefs`), a company or
 * agency login (`payer/me/display-prefs`) and an admin (`admin/me/display-prefs`). Three
 * controllers, one per principal, never one controller serving two; one service and one repository.
 *
 * ITS OWN MODULE, a leaf nothing imports, so no realm's module is edited and no cycle can close.
 * Imports, each for a guard (a guard is instantiated in the module of the controller that mounts
 * it, from that module's providers and imports) or the switch:
 *   - `AuthModule` for `WorkerAuthGuard`;
 *   - `PayersModule` for `PayerAuthGuard` and `PayerTenantScopeService` (the company's tenant key);
 *   - `AdminModule` for `AdminAuthGuard`;
 *   - `FeatureRolloutModule` for `THEME_ROLLOUT` (`isThemeOpenFor`).
 * DATABASE, SERVER_CONFIG and EventsService come from global modules.
 */
@Module({
  imports: [AuthModule, PayersModule, AdminModule, FeatureRolloutModule],
  controllers: [
    WorkerDisplayPrefsController,
    PayerDisplayPrefsController,
    AdminDisplayPrefsController,
  ],
  providers: [DisplayPrefsService, DisplayPrefsRepository],
})
export class DisplayPrefsModule {}
