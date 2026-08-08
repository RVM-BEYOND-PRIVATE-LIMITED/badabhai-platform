import { Module, forwardRef } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { AuthModule } from "../auth/auth.module";
import { ChatModule } from "../chat/chat.module";
import { SkillsModule } from "../skills/skills.module";
import { ProfilesController } from "./profiles.controller";
import { ProfilesService } from "./profiles.service";
import { ProfilesRepository } from "./profiles.repository";
import { AiJobsRepository } from "./ai-jobs.repository";
import { WorkerAttributesRepository } from "./worker-attributes.repository";
import { AiJobsController } from "./ai-jobs.controller";
import { WorkerAiJobsController } from "./worker-ai-jobs.controller";
import { ProfileExtractionProcessor } from "./profile-extraction.processor";
import { AiJobsRetentionSweepProcessor } from "./ai-jobs-retention-sweep.processor";
import {
  AI_JOBS_RETENTION_QUEUE,
  PROFILE_EXTRACTION_QUEUE,
  REFERRAL_BONUS_QUEUE,
  RESUME_GENERATE_QUEUE,
} from "../queue/queue.constants";

@Module({
  imports: [
    // forwardRef: ChatService also depends on ProfilesService (auto-trigger
    // extraction on the readiness flip), so the two modules reference each other.
    forwardRef(() => ChatModule), // for ChatRepository (transcript)
    AuthModule, // WorkerAuthGuard + ConsentGuard for the worker AI routes (inv. 4/6)
    // SkillsRepository — the extraction processor re-validates the RAG-matched
    // job_domain_id against the catalog before persisting it (see resolveJobDomain).
    SkillsModule,
    BullModule.registerQueue({ name: PROFILE_EXTRACTION_QUEUE }),
    // Auto-enqueue a resume render once a profile is confirmed (TD5).
    BullModule.registerQueue({ name: RESUME_GENERATE_QUEUE }),
    // §X.6 — leg 1 of the ₹20 activation-bonus rule fires on confirm. PRODUCER ONLY: the
    // processor lives in ReferralAttributionModule, so this stays a queue registration and
    // NOT a module import (no dependency from `profiles` into `referrals`).
    BullModule.registerQueue({ name: REFERRAL_BONUS_QUEUE }),
    // PERF-3 — the ai_jobs retention sweep queue (repeatable tick; the prune
    // predicate is authoritative; dry-run by default). Lives here because this
    // module owns ai_jobs data access (AiJobsRepository).
    BullModule.registerQueue({ name: AI_JOBS_RETENTION_QUEUE }),
  ],
  // WorkerAiJobsController is a SEPARATE controller from AiJobsController on purpose:
  // guards union class-level with method-level, so a worker route on the ops controller
  // would inherit InternalServiceGuard and break the prod-canary contract. See its
  // docstring. AuthModule (already imported above) supplies WorkerAuthGuard/ConsentGuard.
  controllers: [ProfilesController, AiJobsController, WorkerAiJobsController],
  providers: [
    ProfilesService,
    ProfilesRepository,
    AiJobsRepository,
    // `worker_attributes` — where `attribute`-kind answers land (77% of the pack corpus).
    WorkerAttributesRepository,
    ProfileExtractionProcessor,
    AiJobsRetentionSweepProcessor,
  ],
  exports: [ProfilesRepository, ProfilesService],
})
export class ProfilesModule {}
