import { Module } from "@nestjs/common";
import { CreditRulesModule } from "../credit-rules/credit-rules.module";
import { PayersModule } from "../payers/payers.module";
import { RvmWaiversRepository } from "./rvm-waivers.repository";
import { RvmWaiversService } from "./rvm-waivers.service";

/**
 * #2750 item 5 — the placement team's waivers of the contact cost. Exports
 * {@link RvmWaiversService} (the Campus route and `/admin/waivers` set and list waivers through it)
 * and {@link RvmWaiversRepository} (the unlock path reads which waiver frees a worker, and records
 * its use, through it). DATABASE, SERVER_CONFIG, EventsService and PiiCryptoService come from
 * global modules; PayersModule gives the tenant resolver.
 */
@Module({
  imports: [CreditRulesModule, PayersModule],
  providers: [RvmWaiversRepository, RvmWaiversService],
  exports: [RvmWaiversRepository, RvmWaiversService],
})
export class RvmWaiversModule {}
