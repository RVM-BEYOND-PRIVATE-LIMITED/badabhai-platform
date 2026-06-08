import { Module } from "@nestjs/common";
import { ProfilesModule } from "../profiles/profiles.module";
import { ResumeController } from "./resume.controller";
import { ResumeService } from "./resume.service";
import { ResumeRepository } from "./resume.repository";

@Module({
  imports: [ProfilesModule], // for ProfilesRepository
  controllers: [ResumeController],
  providers: [ResumeService, ResumeRepository],
})
export class ResumeModule {}
