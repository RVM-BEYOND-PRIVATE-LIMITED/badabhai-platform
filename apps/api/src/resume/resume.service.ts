import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { DraftProfileSchema } from "@badabhai/ai-contracts";
import type { GeneratedResume } from "@badabhai/db";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "../workers/workers.repository";
import { ProfilesRepository } from "../profiles/profiles.repository";
import { AiService } from "../ai/ai.service";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { StorageService } from "../storage/storage.service";
import { RESUME_RENDER_QUEUE, type ResumeRenderJobData } from "../queue/queue.constants";
import { ResumeRepository } from "./resume.repository";
import { ResumeRateLimit } from "./resume-rate-limit.service";
import type { GenerateResumeInput, ShareResumeDto } from "./resume.dto";

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
    private readonly storage: StorageService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    @InjectQueue(RESUME_RENDER_QUEUE)
    private readonly renderQueue: Queue<ResumeRenderJobData>,
  ) {}

  async generate(
    dto: GenerateResumeInput,
    ctx: RequestContext,
    opts: { systemInitiated?: boolean; forceNewVersion?: boolean } = {},
  ) {
    // Enforce the daily cap BEFORE any paid AI/render work; fails closed (429) if
    // Redis is down. The system-initiated auto-generate (on profile.confirmed) is
    // one-per-worker + idempotent, so it skips the per-worker abuse cap but still
    // counts against the GLOBAL spend backstop.
    await this.rateLimit.assertWithinDailyCap(dto.worker_id, {
      perWorker: !opts.systemInitiated,
    });

    const profile = await this.profiles.findById(dto.profile_id);
    // OWNERSHIP gate (TD70 item 5): with `worker_id` session-derived in the
    // controller this is the real authz check, not a consistency check —
    // not-found and not-owner are indistinguishable (404, no existence oracle),
    // aligned with download(). The queue processor passes its own job's ids.
    if (!profile || profile.workerId !== dto.worker_id) {
      throw new NotFoundException(`Profile ${dto.profile_id} not found`);
    }

    // Only a CONFIRMED profile may generate a resume (worker-reviewed content →
    // AI spend + TD21 name injection). No oracle needed here: the caller already
    // owns the profile after the check above. The system-initiated path
    // (resume-generate.processor, enqueued ON profile.confirmed) is by definition
    // post-confirm, so it skips the re-read — no ordering hazard if the status
    // write and the queued job ever race.
    if (!opts.systemInitiated && profile.profileStatus !== "confirmed") {
      throw new BadRequestException("profile is not confirmed");
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

    // Resolve the target row. The INITIAL resume (version 1) is idempotent + race-safe
    // via createInitial (partial unique index `generated_resumes_initial_uq`): the
    // auto-generate on profile.confirmed and a manual POST /resume/generate converge on
    // ONE row, even though the worker's name can be recorded AFTER confirm. An explicit
    // regenerate (forceNewVersion) creates the next version instead.
    let saved: GeneratedResume;
    let previousVersion: number | null = null;
    if (opts.forceNewVersion) {
      const previous = await this.workers.latestResume(dto.worker_id);
      previousVersion = previous?.version ?? null;
      saved = await this.resumes.create({
        workerId: dto.worker_id,
        profileId: dto.profile_id,
        resumeJson,
        resumeText,
        version: (previous?.version ?? 0) + 1,
        templateId: "classic",
        // NAME-FREE structured draft, so a future renderer can re-render from the
        // snapshot. The name lives only in resume_json/resume_text (TD21), never here.
        sourceProfileSnapshot: draft,
      });
    } else {
      // Manual generate is authoritative (overwrite content — e.g. a name added after
      // the auto-generate ran); the system auto-generate only fills if absent, so it
      // never clobbers a manual resume.
      saved = await this.resumes.createInitial(
        {
          workerId: dto.worker_id,
          profileId: dto.profile_id,
          resumeJson,
          resumeText,
          version: 1,
          templateId: "classic",
          sourceProfileSnapshot: draft,
        },
        { overwrite: !opts.systemInitiated },
      );
    }

    // A first/initial resume emits `resume.generated`; a regenerate (version > 1) emits
    // `resume.regenerated`. Both payloads are IDs + enums; idempotencyKey dedupes re-emits.
    if (saved.version > 1) {
      await this.events.emit({
        event_name: "resume.regenerated",
        actor: { actor_type: "system" },
        subject: { subject_type: "resume", subject_id: saved.id },
        payload: {
          worker_id: dto.worker_id,
          profile_id: dto.profile_id,
          resume_id: saved.id,
          version: saved.version,
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
          version: saved.version,
          format: result.format,
        },
        idempotencyKey: `resume.generated:${saved.id}`,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    }

    await this.enqueueRender(saved.id, dto.worker_id, ctx);

    return {
      resume_id: saved.id,
      version: saved.version,
      format: result.format,
      is_mock: result.is_mock,
      resume_text: saved.resumeText,
    };
  }

  /**
   * Enqueue the async PDF render (refs only, no PII). A queue failure must not
   * fail generation — log a warning and leave render_status 'pending' (a later
   * regenerate/retry can re-enqueue).
   */
  private async enqueueRender(
    resumeId: string,
    workerId: string,
    ctx: RequestContext,
  ): Promise<void> {
    try {
      await this.renderQueue.add("render", {
        resumeId,
        workerId,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    } catch (err) {
      this.logger.warn(
        `could not enqueue resume render for ${resumeId}; leaving render_status pending (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
  }

  /** Ops read view of a single resume (404 if missing). The body carries the
   * worker's OWN name by design (TD21); the phone never appears. */
  async getById(resumeId: string) {
    const resume = await this.resumes.findById(resumeId);
    if (!resume) throw new NotFoundException(`Resume ${resumeId} not found`);
    return {
      resume_id: resume.id,
      worker_id: resume.workerId,
      profile_id: resume.profileId,
      version: resume.version,
      resume_text: resume.resumeText,
      resume_json: resume.resumeJson,
      render_status: resume.renderStatus,
      generated_at: resume.generatedAt,
    };
  }

  /** Re-run generation for an existing resume (bumps the version). 404 if missing. */
  async regenerate(resumeId: string, ctx: RequestContext) {
    const existing = await this.resumes.findById(resumeId);
    if (!existing) throw new NotFoundException(`Resume ${resumeId} not found`);
    return this.generate(
      { worker_id: existing.workerId, profile_id: existing.profileId },
      ctx,
      { forceNewVersion: true },
    );
  }

  /**
   * Mint a short-lived signed download URL for a rendered resume PDF and emit
   * `resume.downloaded`. Worker-authenticated + ownership-checked: both not-found
   * AND not-owner return 404 (no existence oracle). 409 while still rendering /
   * if it failed. The signed URL is NOT logged or emitted (it embeds a token).
   */
  async download(
    workerId: string,
    resumeId: string,
    ctx: RequestContext,
  ): Promise<{ url: string; expires_in: number }> {
    const resume = await this.resumes.findById(resumeId);
    if (!resume || resume.workerId !== workerId) {
      throw new NotFoundException(`Resume ${resumeId} not found`);
    }

    if (resume.renderStatus !== "rendered" || !resume.pdfStorageKey) {
      if (resume.renderStatus === "pending") {
        throw new ConflictException("Resume PDF is still being rendered; please retry shortly");
      }
      throw new ConflictException("Resume PDF is not available for download");
    }

    const ttl = this.config.RESUME_SIGNED_URL_TTL_SECONDS;
    const url = await this.storage.createSignedUrl(resume.pdfStorageKey, ttl);

    await this.events.emit({
      event_name: "resume.downloaded",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "resume", subject_id: resume.id },
      payload: {
        worker_id: workerId,
        resume_id: resume.id,
        version: resume.version,
        format: "pdf",
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return { url, expires_in: ttl };
  }

  /**
   * Record that a worker shared a resume. `channel` is a closed enum, so no link
   * or PII enters the `resume.shared` event. 404 if the resume is missing.
   */
  async recordShare(resumeId: string, dto: ShareResumeDto, ctx: RequestContext) {
    const resume = await this.resumes.findById(resumeId);
    if (!resume) throw new NotFoundException(`Resume ${resumeId} not found`);

    await this.events.emit({
      event_name: "resume.shared",
      actor: { actor_type: "worker", actor_id: resume.workerId },
      subject: { subject_type: "resume", subject_id: resume.id },
      payload: {
        worker_id: resume.workerId,
        resume_id: resume.id,
        version: resume.version,
        channel: dto.channel,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return { ok: true };
  }
}
