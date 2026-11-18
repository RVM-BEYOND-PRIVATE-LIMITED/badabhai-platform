import { Module } from "@nestjs/common";
import { AdminModule } from "../admin.module";
import { EventsModule } from "../../events/events.module";
import { CandidateSearchRepository } from "../../candidates/candidate-search.repository";
import { AdminNumbersEnabledGuard } from "../numbers/admin-numbers.flag";
import { AdminLaunchTestsController } from "./admin-launch-tests.controller";
import { AdminLaunchTestsRepository } from "./admin-launch-tests.repository";
import { AdminLaunchTestsService } from "./admin-launch-tests.service";

/**
 * #2755 part D — the two pre-launch tests' records, `/admin/launch-tests/*`. A leaf module above
 * `AdminModule` (for its guards and `AdminIdentityService`), one-directional like
 * `AdminNumbersModule`: nothing imports it back. INERT until `ADMIN_NUMBERS_ENABLED` is on — every
 * route is a neutral 404 before any query.
 *
 * `CandidateSearchRepository` (the search pool's own membership rule) needs only DATABASE and the
 * global config, so it is PROVIDED here rather than imported with `CandidatesModule` (the
 * `AdminModule` pattern): only its read `findCardRow` is called. `PiiCryptoService`, DATABASE and
 * SERVER_CONFIG are global.
 */
@Module({
  imports: [AdminModule, EventsModule],
  controllers: [AdminLaunchTestsController],
  providers: [
    AdminLaunchTestsRepository,
    AdminLaunchTestsService,
    AdminNumbersEnabledGuard,
    CandidateSearchRepository,
  ],
})
export class AdminLaunchTestsModule {}
