import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { NotificationsController } from "./notifications.controller";
import { NotificationPrefsController } from "./notification-prefs.controller";
import { NotificationsService } from "./notifications.service";
import { NotificationStateService } from "./notification-state.service";
import { NotificationsRepository } from "./notifications.repository";

/**
 * Worker Alerts: the feed (GET /workers/me/notifications), its read watermark
 * (POST /workers/me/notifications/read) and the push toggle (GET/PATCH
 * /workers/me/notification-prefs) — #643.
 *
 * Imports AuthModule for WorkerAuthGuard + ConsentGuard (same as WorkersModule).
 * DATABASE, WorkersRepository and EventsService are all @Global, so the repository
 * and NotificationStateService inject them without an import here.
 */
@Module({
  imports: [AuthModule],
  controllers: [NotificationsController, NotificationPrefsController],
  providers: [NotificationsService, NotificationStateService, NotificationsRepository],
})
export class NotificationsModule {}
