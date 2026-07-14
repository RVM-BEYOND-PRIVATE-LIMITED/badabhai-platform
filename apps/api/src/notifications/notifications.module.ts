import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";
import { NotificationsRepository } from "./notifications.repository";

/**
 * Worker Alerts feed (GET /workers/me/notifications). Imports AuthModule for
 * WorkerAuthGuard + ConsentGuard (same as WorkersModule). DATABASE is @Global
 * (DatabaseModule), so the repository injects it without an import here.
 */
@Module({
  imports: [AuthModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsRepository],
})
export class NotificationsModule {}
