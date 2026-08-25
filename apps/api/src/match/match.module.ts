import { Global, Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { PayersModule } from "../payers/payers.module";
import { REACH_WIDEN_EXPIRY_QUEUE } from "../queue/queue.constants";
import { MatchConfigRepository } from "./match-config.repository";
import { MatchConfigService } from "./match-config.service";
import { WorkerSkillsRepository } from "./worker-skills.repository";
import { WorkerSkillsService } from "./worker-skills.service";
import { MatchSkillsController } from "./match-skills.controller";
import { MatchSkillsService } from "./match-skills.service";
import { PublishReachService } from "./publish-reach.service";
import { ReachWidenRepository } from "./reach-widen.repository";
import { ReachWidenExpirySweepProcessor } from "./reach-widen-expiry-sweep.processor";
import { MatchFeedRepository } from "./match-feed.repository";
import { MatchFeedService } from "./match-feed.service";
import { MatchApplyService } from "./match-apply.service";
import { MatchCandidatesService } from "./match-candidates.service";
import { FreeTierService } from "./free-tier.service";

/**
 * Matching V1 (ADR-0036) — the shared matching layer.
 *
 * `@Global` because five unrelated modules need it and none of them owns it:
 * `ProfilesModule` (the extraction processor, moments ①/②), `JobPostingsModule`
 * (moment ③, publish/unpause), `ApplicationsModule` (moments ④/⑤, feed + apply),
 * `PayerPortalModule` (moment ⑥, the candidate list) and `PostingPlansModule` (the
 * boost supply gate). Wiring five import edges to a leaf module that only exposes
 * config + two stateless services would be ceremony, and it is the same call
 * `WorkersModule`/`CryptoModule` already make for the same reason.
 *
 * The module owns NO ranking. `@badabhai/match-engine` is the only place the maths
 * lives; these services map DB rows onto its types and back.
 */
@Global()
@Module({
  imports: [
    // PayerAuthGuard for the two payer-facing posting-form routes.
    PayersModule,
    // The widen-expiry sweep's clock (Policy 27 "Expiring"). The queue token is
    // registered here because the processor lives here; the tick carries no payload
    // and nothing else produces to it.
    BullModule.registerQueue({ name: REACH_WIDEN_EXPIRY_QUEUE }),
  ],
  controllers: [MatchSkillsController],
  providers: [
    MatchConfigRepository,
    MatchConfigService,
    WorkerSkillsRepository,
    WorkerSkillsService,
    MatchSkillsService,
    PublishReachService,
    ReachWidenRepository,
    ReachWidenExpirySweepProcessor,
    MatchFeedRepository,
    MatchFeedService,
    MatchApplyService,
    MatchCandidatesService,
    FreeTierService,
  ],
  exports: [
    MatchConfigService,
    WorkerSkillsService,
    WorkerSkillsRepository,
    MatchSkillsService,
    PublishReachService,
    MatchFeedRepository,
    MatchFeedService,
    MatchApplyService,
    MatchCandidatesService,
    FreeTierService,
  ],
})
export class MatchModule {}
