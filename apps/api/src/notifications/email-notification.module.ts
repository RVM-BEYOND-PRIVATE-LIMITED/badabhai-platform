import { Global, Module } from "@nestjs/common";
import { EmailNotificationService } from "./email-notification.service";

/**
 * ADR-0038 Decision 2 — the principal-agnostic OUTBOUND-EMAIL pipeline.
 *
 * Deliberately separate from {@link import("./notifications.module").NotificationsModule},
 * which despite the shared directory is a different thing entirely: that one serves the
 * worker's IN-APP alerts feed (a controller + repository over `notifications` rows). This
 * one has no controller, no table and no principal — it is a transport.
 *
 * @Global because every principal sends mail (worker, payer, agency, admin). The
 * alternative is an import edge from each of their modules whose only content is "can send
 * email", plus another the day a fifth principal appears. The service holds no
 * per-principal state, so one shared instance is the right shape — the same reasoning that
 * makes ConfigModule and the PII crypto service global.
 */
@Global()
@Module({
  providers: [EmailNotificationService],
  exports: [EmailNotificationService],
})
export class EmailNotificationModule {}
