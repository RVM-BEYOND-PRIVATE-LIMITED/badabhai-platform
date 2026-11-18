import { Module } from "@nestjs/common";
import { RvmWaiversModule } from "../rvm-waivers/rvm-waivers.module";
import { CampusLinkModule } from "./campus-link.module";
import { CampusWaiversController } from "./campus-waivers.controller";

/**
 * #2750 item 5 — the placement team's waiver switch on the Campus service API. CampusLinkModule
 * gives the Campus credential guard; RvmWaiversModule the waiver service. Its own module (like
 * CampusReviewModule) so the Campus link carries no dependency on the credit rules.
 */
@Module({
  imports: [CampusLinkModule, RvmWaiversModule],
  controllers: [CampusWaiversController],
})
export class CampusWaiversModule {}
