import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { SearchExitController } from "./search-exit.controller";
import { SearchExitRepository } from "./search-exit.repository";
import { SearchExitService } from "./search-exit.service";

/**
 * #2753 item 6 — LEAVE COMPANY SEARCH: the worker's `workers/me/search-visibility` switch.
 *
 * ITS OWN MODULE, a leaf nothing imports, so no realm's module is edited and no cycle can close.
 * Imports `AuthModule` for `WorkerAuthGuard` and `ConsentGuard` (a guard is instantiated in the
 * module of the controller that mounts it, from that module's providers and imports; AuthModule
 * re-exports ConsentModule for ConsentGuard's repository). DATABASE, SERVER_CONFIG (the switch and
 * `SearchExitEnabledGuard`) and EventsService come from global modules.
 *
 * The two READERS of `worker_search_exits` live where they act and need no provider from here: the
 * search pool's predicate (`CandidateSearchRepository`) and the unlock refusal
 * (`searchExitRefuses`, a plain function the unlock transaction calls on its own `tx`).
 */
@Module({
  imports: [AuthModule],
  controllers: [SearchExitController],
  providers: [SearchExitService, SearchExitRepository],
  exports: [SearchExitService],
})
export class SearchExitModule {}
