import { Module } from "@nestjs/common";
import { CampusLinkController } from "./campus-link.controller";
import { CampusCallAuditRepository } from "./campus-call-audit.repository";
import { CampusServiceGuard } from "./campus-service.guard";

/**
 * The Campus link, BadaBhai side (#2752). DATABASE, SERVER_CONFIG and SubjectRateLimit come from
 * global modules. The guard is exported so #2746 and #2750 mount their Campus routes behind the
 * same credential instead of minting a second one.
 */
@Module({
  controllers: [CampusLinkController],
  providers: [CampusCallAuditRepository, CampusServiceGuard],
  exports: [CampusServiceGuard, CampusCallAuditRepository],
})
export class CampusLinkModule {}
