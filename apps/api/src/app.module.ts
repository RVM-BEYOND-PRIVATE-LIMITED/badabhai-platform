import { Module, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import { AppConfigModule } from "./config/config.module";
import { DatabaseModule } from "./database/database.module";
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
import { RequestIdMiddleware } from "./common/middleware/request-id.middleware";

@Module({
  imports: [
    // Global cross-cutting modules:
    AppConfigModule,
    DatabaseModule,
    EventsModule,
    AiModule,
    WorkersModule,
    // Feature modules:
    HealthModule,
    AuthModule,
    ConsentModule,
    ChatModule,
    VoiceModule,
    ProfilesModule,
    ResumeModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes("*");
  }
}
