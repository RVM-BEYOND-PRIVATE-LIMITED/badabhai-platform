import { Module } from "@nestjs/common";
import { ConsentController } from "./consent.controller";
import { ConsentService } from "./consent.service";
import { ConsentRepository } from "./consent.repository";

@Module({
  controllers: [ConsentController],
  providers: [ConsentService, ConsentRepository],
  // Export the repository so ConsentGuard (provided in AuthModule) can read the
  // worker's latest consent. A guard used cross-module needs its dependency
  // available in the injector that resolves it (see AuthModule's note on
  // WorkerAuthGuard + SessionService) — exporting it here is what makes the app
  // boot, not just the unit tests.
  exports: [ConsentRepository],
})
export class ConsentModule {}
