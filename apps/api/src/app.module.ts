import { Module, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import { AppConfigModule } from "./config/config.module";
import { CryptoModule } from "./common/crypto.module";
import { DatabaseModule } from "./database/database.module";
import { QueueModule } from "./queue/queue.module";
import { EventsModule } from "./events/events.module";
import { AiModule } from "./ai/ai.module";
import { WorkersModule } from "./workers/workers.module";
import { HealthModule } from "./health/health.module";
import { AuthModule } from "./auth/auth.module";
import { ConsentModule } from "./consent/consent.module";
import { ChatModule } from "./chat/chat.module";
import { VoiceModule } from "./voice/voice.module";
import { ProfilesModule } from "./profiles/profiles.module";
import { ResumeModule } from "./resume/resume.module";
import { InterviewKitModule } from "./interview-kit/interview-kit.module";
import { ActionsModule } from "./actions/actions.module";
import { ApplicationsModule } from "./applications/applications.module";
import { JobPostingsModule } from "./job-postings/job-postings.module";
import { ReachModule } from "./reach/reach.module";
import { UnlocksModule } from "./unlocks/unlocks.module";
import { RateLimitModule } from "./common/rate-limit/rate-limit.module";
import { PdfModule } from "./common/pdf/pdf.module";
import { RequestIdMiddleware } from "./common/middleware/request-id.middleware";

@Module({
  imports: [
    // Global cross-cutting modules:
    AppConfigModule,
    CryptoModule,
    DatabaseModule,
    QueueModule,
    EventsModule,
    AiModule,
    WorkersModule,
    RateLimitModule,
    PdfModule,
    // Feature modules:
    HealthModule,
    AuthModule,
    ConsentModule,
    ChatModule,
    VoiceModule,
    ProfilesModule,
    ResumeModule,
    InterviewKitModule,
    ActionsModule,
    ApplicationsModule,
    JobPostingsModule,
    ReachModule,
    UnlocksModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes("*");
  }
}
