import { Module } from "@nestjs/common";
import { PayersModule } from "../../payers/payers.module";
import { JobPostingsModule } from "../../job-postings/job-postings.module";
import { JobPostingChatController } from "./job-posting-chat.controller";
import { JobPostingChatService } from "./job-posting-chat.service";
import { JobPostingChatRepository } from "./job-posting-chat.repository";

/**
 * AI job-posting chat (ADR-0035 §Decision 5).
 *
 * TWO IMPORTS, BOTH REUSE, NEITHER A FORK:
 *  - {@link PayersModule} supplies `PayerAuthGuard` (the existing payer principal — no
 *    new guard, no new session mechanism) and `PayersRepository` (the ONLY reader of
 *    `payers.orgNameEnc`, which publish stamps onto the create call server-side).
 *  - {@link JobPostingsModule} exports `JobPostingsService` — the UNCHANGED create path
 *    the publish step calls. Importing the real service, rather than writing a parallel
 *    insert, is what keeps `job_posting.created` single-writer.
 *
 * `EventsService`, `PiiCryptoService`, `AiService` and `SERVER_CONFIG` are all @Global
 * (EventsModule / CryptoModule / AiModule / AppConfigModule) and need no import here.
 *
 * Mounted by {@link import("../payer-portal.module").PayerPortalModule} alongside the
 * other `/payer/*` route groups.
 */
@Module({
  imports: [PayersModule, JobPostingsModule],
  controllers: [JobPostingChatController],
  providers: [JobPostingChatService, JobPostingChatRepository],
})
export class JobPostingChatModule {}
