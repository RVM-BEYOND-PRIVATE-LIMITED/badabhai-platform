import { Module } from "@nestjs/common";
import { ConsentRepository } from "../consent/consent.repository";
import { PayersModule } from "../payers/payers.module";
import { CampusGrantsController } from "./campus-grants.controller";
import { CampusLinkController } from "./campus-link.controller";
import { CampusCallAuditRepository } from "./campus-call-audit.repository";
import { CampusServiceGuard } from "./campus-service.guard";
import { InstituteAiGate } from "./institute-ai-gate.service";
import { InstituteLinkRepository } from "./institute-link.repository";
import { InstituteLinkService } from "./institute-link.service";
import { InstituteOpenGate } from "./institute-open-gate.service";
import { InstituteSearchGrantsRepository } from "./institute-search-grants.repository";
import { InstituteSearchGrantsService } from "./institute-search-grants.service";
import { RvmStudentApiClient } from "./rvm-student-api.client";

/**
 * The Campus link, BadaBhai side (#2752). DATABASE, SERVER_CONFIG, SubjectRateLimit,
 * EventsService, PiiCryptoService and WorkersRepository come from global modules. The guard is
 * exported so #2746 and #2750 mount their Campus routes behind the same credential instead of
 * minting a second one; the link service and the RVM client are exported for the routes that
 * apply, grant and open (#2752 parts C and E, #2747). `InstituteOpenGate` is exported for the
 * unlock and résumé-disclosure chokepoints, which ask it before opening any worker, and
 * `InstituteAiGate` for every AI path a linked student could otherwise reach off his own request.
 *
 * `ConsentRepository` is PROVIDED HERE RATHER THAN IMPORTED FROM ConsentModule: its only
 * dependency is the @Global DATABASE, so providing it adds no edge, while importing ConsentModule
 * would pull in AuthModule (a forwardRef) and give this module, which unlocks, disclosures,
 * profiles, résumé, profiling and voice all import, a way into a cycle.
 *
 * `PayersModule` (one-way: it imports nothing from here) — `PayerTenantScopeService`, so a grant
 * is stored under the company's TENANT key, the key its search and its opens are asked by.
 *
 * Part E's jobs and applications routes live in `CampusJobsModule`, which imports this one: they
 * need `JobPostingsModule`, whose tree reaches the modules that import this one, so here it would
 * close a cycle.
 */
@Module({
  imports: [PayersModule],
  controllers: [CampusLinkController, CampusGrantsController],
  providers: [
    CampusCallAuditRepository,
    CampusServiceGuard,
    ConsentRepository,
    InstituteAiGate,
    InstituteLinkRepository,
    InstituteLinkService,
    InstituteOpenGate,
    InstituteSearchGrantsRepository,
    InstituteSearchGrantsService,
    RvmStudentApiClient,
  ],
  exports: [
    CampusServiceGuard,
    CampusCallAuditRepository,
    InstituteAiGate,
    InstituteLinkService,
    InstituteOpenGate,
    RvmStudentApiClient,
  ],
})
export class CampusLinkModule {}
