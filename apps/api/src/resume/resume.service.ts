import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { DraftProfileSchema } from "@badabhai/ai-contracts";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";
import { ProfilesRepository } from "../profiles/profiles.repository";
import { AiService } from "../ai/ai.service";
import { ResumeRepository } from "./resume.repository";
import type { GenerateResumeDto } from "./resume.dto";

@Injectable()
export class ResumeService {
  constructor(
    private readonly resumes: ResumeRepository,
    private readonly profiles: ProfilesRepository,
    private readonly workers: WorkersRepository,
    private readonly events: EventsService,
    private readonly ai: AiService,
  ) {}

  async generate(dto: GenerateResumeDto, ctx: RequestContext) {
    const profile = await this.profiles.findById(dto.profile_id);
    if (!profile) throw new NotFoundException(`Profile ${dto.profile_id} not found`);
    if (profile.workerId !== dto.worker_id) {
      throw new BadRequestException("worker_id does not match the profile owner");
    }

    // The stored rawProfile is the structured DraftProfile; re-validate its shape.
    const draft = DraftProfileSchema.parse(profile.rawProfile);

    // The AI service receives ONLY the structured profile (no name/phone).
    const result = await this.ai.generateResume({ profile: draft });

    const previous = await this.workers.latestResume(dto.worker_id);
    const version = (previous?.version ?? 0) + 1;

    const saved = await this.resumes.create({
      workerId: dto.worker_id,
      profileId: dto.profile_id,
      resumeJson: result.resume_json,
      resumeText: result.resume_text,
      version,
    });

    await this.events.emit({
      event_name: "resume.generated",
      actor: { actor_type: "system" },
      subject: { subject_type: "resume", subject_id: saved.id },
      payload: {
        worker_id: dto.worker_id,
        profile_id: dto.profile_id,
        resume_id: saved.id,
        version,
        format: result.format,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return {
      resume_id: saved.id,
      version,
      format: result.format,
      is_mock: result.is_mock,
      resume_text: saved.resumeText,
    };
  }
}
