import { WorkHistoryPolishService } from "./work-history-polish.service";
import { Module, forwardRef } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { AuthModule } from "../auth/auth.module";
import { ProfilesModule } from "../profiles/profiles.module";
import { ProfilingModule } from "../profiling/profiling.module";
import { StorageModule } from "../storage/storage.module";
import { ReferralLinksModule } from "../referrals/referral-links.module";
import { RESUME_GENERATE_QUEUE, RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { ResumeController } from "./resume.controller";
import { ResumeService } from "./resume.service";
import { ResumeRepository } from "./resume.repository";
import { ResumeRenderer } from "./resume-renderer.service";
import { ResumeRateLimit } from "./resume-rate-limit.service";
import { ResumeGenerateProcessor } from "./resume-generate.processor";
import { ResumeRenderProcessor } from "./resume-render.processor";
import { ProfilingTierRepository } from "../profiling/tiers/profiling-tier.repository";
import { ResumeTierScopeReader } from "./resume-tier-scope.reader";
import { GeneralRoadRepository } from "./general-road.repository";
import { GeneralRoadReader } from "./general-road.reader";
import { ResumeSkinRepository } from "./resume-skin.repository";
import { ResumeSkinReader } from "./resume-skin.reader";
import { ResumeSkinService } from "./resume-skin.service";
import { ResumeRerenderService } from "./resume-rerender.service";

/**
 * Resume generation + async PDF render (TD5).
 *
 * EventsService (EventsModule), AiService (AiModule), WorkersRepository
 * (WorkersModule) and PiiCryptoService (CryptoModule) are all @Global, so only
 * ProfilesModule (ProfilesRepository), ProfilingModule (TradeFormRepository)
 * and StorageModule are imported here. Both the generate and render queues are
 * registered so the producers (this service / ProfilesService) and the
 * in-process processors agree on the names.
 */
@Module({
  imports: [
    AuthModule, // for WorkerAuthGuard (worker-authenticated PDF download)
    ProfilesModule, // for ProfilesRepository
    forwardRef(() => ProfilingModule), // for TradeFormRepository (read-only pack answers)
    StorageModule, // for StorageService (signed URLs + PDF upload)
    // #1800 — ResumeQrLinkService: the render worker's get-or-create of the worker's `resume_qr`
    // link, whose `/r/<code>` their own résumé QR encodes. A leaf module (no imports), so no
    // cycle; nothing queries `referral_links` from here while RESUME_QR_SCAN_ENABLED is off.
    ReferralLinksModule,
    BullModule.registerQueue({ name: RESUME_GENERATE_QUEUE }),
    BullModule.registerQueue({ name: RESUME_RENDER_QUEUE }),
  ],
  controllers: [ResumeController],
  providers: [
    ResumeService,
    ResumeRepository,
    ResumeRenderer,
    ResumeRateLimit,
    ResumeGenerateProcessor,
    ResumeRenderProcessor,
    WorkHistoryPolishService,
    // Tiered profiling — the sheet renders at the worker's tier. The repository depends only on
    // the @Global DATABASE (provided here, the WorkerAttributesRepository precedent);
    // TradeFormRepository comes from ProfilingModule above. Neither is queried while
    // PROFILING_TIERS_ENABLED is off.
    ProfilingTierRepository,
    ResumeTierScopeReader,
    // ADR-0045 Phase 5 — the general road, by the résumé's own provenance. The repository depends
    // only on the @Global DATABASE (provided here on the same terms as the tier repository), and
    // the reader queries only for a `bb_general` render.
    GeneralRoadRepository,
    GeneralRoadReader,
    // #1801 — résumé skins. The repository depends only on the @Global DATABASE (provided here on
    // the tier repository's terms); the re-render seam on the @Global WorkersRepository and the
    // RESUME_RENDER_QUEUE registered above. Nothing queries `worker_resume_skin` while
    // RESUME_SKINS_ENABLED is off.
    ResumeSkinRepository,
    ResumeSkinReader,
    ResumeSkinService,
    ResumeRerenderService,
  ],
  // ADR-0044 — the post-completion chat companion tells the worker how their résumé was made and
  // what it says. It reads `history()` — the SAME projection the Resume tab shows (source,
  // trigger, the rendered glance facts, pending_update) — so the chat can never describe a
  // different résumé than the tab. `history()` is a pure read: no event, no generation.
  exports: [ResumeService],
})
export class ResumeModule {}
