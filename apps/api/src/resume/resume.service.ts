import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { DraftProfileSchema } from "@badabhai/ai-contracts";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";
import { ProfilesRepository } from "../profiles/profiles.repository";
import { AiService } from "../ai/ai.service";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { ResumeRepository } from "./resume.repository";
import type { GenerateResumeDto } from "./resume.dto";

@Injectable()
export class ResumeService {
  private readonly logger = new Logger(ResumeService.name);

  constructor(
    private readonly resumes: ResumeRepository,
    private readonly profiles: ProfilesRepository,
    private readonly workers: WorkersRepository,
    private readonly events: EventsService,
    private readonly ai: AiService,
    private readonly pii: PiiCryptoService,
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

    // TD21: put the worker's real name on the resume — decrypted SERVER-SIDE and
    // injected AFTER the AI call, so the name never reaches the LLM (the AI service
    // only ever saw the structured profile above). The name is absent if not set yet.
    const worker = await this.workers.findById(dto.worker_id);
    let fullName: string | null = null;
    if (worker?.fullName) {
      try {
        fullName = this.pii.decrypt(worker.fullName);
      } catch {
        // A malformed / rotated-key / tampered token must NOT 500 resume generation
        // (e.g. after a key rotation it would break every existing worker at once).
        // Degrade to a name-less resume — same as no name set. Never log the token/error.
        this.logger.warn(
          `could not decrypt full_name for worker ${dto.worker_id}; generating a name-less resume`,
        );
      }
    }
    const resumeText = fullName ? `${fullName}\n${result.resume_text}` : result.resume_text;
    const resumeJson = fullName ? { ...result.resume_json, name: fullName } : result.resume_json;

    const previous = await this.workers.latestResume(dto.worker_id);
    const version = (previous?.version ?? 0) + 1;

    const saved = await this.resumes.create({
      workerId: dto.worker_id,
      profileId: dto.profile_id,
      resumeJson,
      resumeText,
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
      idempotencyKey: `resume.generated:${saved.id}`,
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
