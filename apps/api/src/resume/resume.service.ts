import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { DraftProfileSchema } from "@badabhai/ai-contracts";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";
import { ProfilesRepository } from "../profiles/profiles.repository";
import { AiService } from "../ai/ai.service";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { RESUME_RENDER_QUEUE, type ResumeRenderJobData } from "../queue/queue.constants";
import { ResumeRepository } from "./resume.repository";
import { ResumeRateLimit } from "./resume-rate-limit.service";
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
    private readonly rateLimit: ResumeRateLimit,
    @InjectQueue(RESUME_RENDER_QUEUE)
    private readonly renderQueue: Queue<ResumeRenderJobData>,
  ) {}

  async generate(
    dto: GenerateResumeDto,
    ctx: RequestContext,
    opts: { systemInitiated?: boolean } = {},
  ) {
    // Enforce the daily cap BEFORE any paid AI/render work; fails closed (429) if
    // Redis is down. The system-initiated auto-generate (on profile.confirmed) is
    // one-per-worker + idempotent, so it skips the per-worker abuse cap but still
    // counts against the GLOBAL spend backstop.
    await this.rateLimit.assertWithinDailyCap(dto.worker_id, {
      perWorker: !opts.systemInitiated,
    });

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
    const previousVersion = previous?.version ?? null;
    const version = (previous?.version ?? 0) + 1;

    const saved = await this.resumes.create({
      workerId: dto.worker_id,
      profileId: dto.profile_id,
      resumeJson,
      resumeText,
      version,
      templateId: "classic",
      // NAME-FREE structured draft, so a future renderer can re-render from the
      // snapshot. The name lives only in resume_json/resume_text (TD21), never here.
      sourceProfileSnapshot: draft,
    });

    // A first-ever resume emits `resume.generated`; a re-run (version > 1) emits
    // `resume.regenerated` with the previous version. Both payloads are IDs + enums.
    if (version > 1) {
      await this.events.emit({
        event_name: "resume.regenerated",
        actor: { actor_type: "system" },
        subject: { subject_type: "resume", subject_id: saved.id },
        payload: {
          worker_id: dto.worker_id,
          profile_id: dto.profile_id,
          resume_id: saved.id,
          version,
          previous_version: previousVersion,
          format: result.format,
        },
        idempotencyKey: `resume.regenerated:${saved.id}`,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    } else {
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
    }

    // Enqueue the async PDF render (refs only, no PII). A queue failure must not
    // fail generation — log a warning and leave render_status 'pending' (a later
    // regenerate/retry can re-enqueue).
    try {
      await this.renderQueue.add("render", {
        resumeId: saved.id,
        workerId: dto.worker_id,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    } catch (err) {
      this.logger.warn(
        `could not enqueue resume render for ${saved.id}; leaving render_status pending (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }

    return {
      resume_id: saved.id,
      version,
      format: result.format,
      is_mock: result.is_mock,
      resume_text: saved.resumeText,
    };
  }
}
