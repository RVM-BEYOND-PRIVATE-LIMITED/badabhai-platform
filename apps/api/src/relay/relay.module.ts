import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PayersModule } from "../payers/payers.module";
import { UnlocksModule } from "../unlocks/unlocks.module";
import { PayerRelayController } from "./payer-relay.controller";
import { WorkerRelayController } from "./worker-relay.controller";
import { RelayRepository } from "./relay.repository";
import { RelayService } from "./relay.service";

/**
 * The in-app relay (E0, `docs/agent/phases/E0_BUILD.md`): the payer's send surface, the
 * worker's read/reply surface, and the one message table between them.
 *
 * IMPORTS, and each is load-bearing:
 *  - `AuthModule`     — WorkerAuthGuard + ConsentGuard for the worker routes.
 *  - `PayersModule`   — PayerAuthGuard for the payer route (a guard's dependencies must be
 *                       reachable in the importing module's injector, or the app fails to
 *                       boot with the controller mounted — the MatchModule lesson).
 *  - `UnlocksModule`  — the EXPORTED `UnlockService`, which owns the fail-closed resolution
 *                       ladder. `UnlocksRepository` stays unexported: the relay never
 *                       writes `unlocks`/`unlock_routing` (single-writer is structural).
 *
 * DATABASE, EventsService and WorkersRepository are @Global, so the repository and service
 * inject them without an import here.
 */
@Module({
  imports: [AuthModule, PayersModule, UnlocksModule],
  controllers: [PayerRelayController, WorkerRelayController],
  providers: [RelayService, RelayRepository],
})
export class RelayModule {}
