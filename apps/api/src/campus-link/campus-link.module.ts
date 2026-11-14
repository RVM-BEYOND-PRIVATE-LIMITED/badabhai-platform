import { Module } from "@nestjs/common";
import { CampusLinkController } from "./campus-link.controller";
import { CampusCallAuditRepository } from "./campus-call-audit.repository";
import { CampusServiceGuard } from "./campus-service.guard";
import { InstituteLinkRepository } from "./institute-link.repository";
import { InstituteLinkService } from "./institute-link.service";
import { InstituteOpenGate } from "./institute-open-gate.service";
import { RvmStudentApiClient } from "./rvm-student-api.client";

/**
 * The Campus link, BadaBhai side (#2752). DATABASE, SERVER_CONFIG, SubjectRateLimit,
 * EventsService, PiiCryptoService and WorkersRepository come from global modules. The guard is
 * exported so #2746 and #2750 mount their Campus routes behind the same credential instead of
 * minting a second one; the link service and the RVM client are exported for the routes that
 * apply, grant and open (#2752 parts C and E, #2747). `InstituteOpenGate` is exported for the
 * unlock and résumé-disclosure chokepoints, which ask it before opening any worker.
 */
@Module({
  controllers: [CampusLinkController],
  providers: [
    CampusCallAuditRepository,
    CampusServiceGuard,
    InstituteLinkRepository,
    InstituteLinkService,
    InstituteOpenGate,
    RvmStudentApiClient,
  ],
  exports: [
    CampusServiceGuard,
    CampusCallAuditRepository,
    InstituteLinkService,
    InstituteOpenGate,
    RvmStudentApiClient,
  ],
})
export class CampusLinkModule {}
