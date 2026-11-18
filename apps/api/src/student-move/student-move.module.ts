import { Module } from "@nestjs/common";
import { StudentVisibilityRepository } from "./student-visibility.repository";
import { StudentVisibilityService } from "./student-visibility.service";
import { WorkerFieldSourcesRepository } from "./worker-field-sources";

/**
 * #2887 — the bulk move of RVM students into BadaBhai: the visibility switch (`/admin/students/*`
 * through AdminModule) and the import side of the field source marker. DATABASE, SERVER_CONFIG and
 * EventsService come from global modules; WorkerSkillsService from the @Global MatchModule (the
 * reach rebuild after a visibility change).
 */
@Module({
  providers: [StudentVisibilityRepository, StudentVisibilityService, WorkerFieldSourcesRepository],
  exports: [StudentVisibilityService, WorkerFieldSourcesRepository],
})
export class StudentMoveModule {}
