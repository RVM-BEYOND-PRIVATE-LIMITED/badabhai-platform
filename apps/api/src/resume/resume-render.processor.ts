import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { DraftProfileSchema } from "@badabhai/ai-contracts";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { WorkersRepository } from "../workers/workers.repository";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { StorageService } from "../storage/storage.service";
import { ResumeRepository } from "./resume.repository";
import { ResumeRenderer, type ResumeRenderInput } from "./resume-renderer.service";
import { RESUME_RENDER_QUEUE, type ResumeRenderJobData } from "../queue/queue.constants";

/**
 * Renders a resume PDF off the request path (NODE-ONLY render, see ADR).
 *
 * SECURITY: the worker's real name is decrypted SERVER-SIDE here (same degrade-
 * on-failure discipline as ResumeService), placed onto the PDF, and uploaded.
 * It is NEVER logged, NEVER put into an event, and NEVER enqueued. No event is
 * emitted on render completion — only the row's render_status flips.
 *
 * Render is degrade-to-null: renderer returns null when the kill-switch is off
 * or WeasyPrint is missing/failed. We only flip the row to 'failed' on the FINAL
 * BullMQ attempt (mirrors the voice processor's terminal-failure handling), so
 * transient issues get retried while the row stays 'pending'.
 */
@Processor(RESUME_RENDER_QUEUE)
export class ResumeRenderProcessor extends WorkerHost {
  private readonly logger = new Logger(ResumeRenderProcessor.name);

  constructor(
    private readonly resumes: ResumeRepository,
    private readonly workers: WorkersRepository,
    private readonly pii: PiiCryptoService,
    private readonly renderer: ResumeRenderer,
    private readonly storage: StorageService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {
    super();
  }

  async process(job: Job<ResumeRenderJobData>): Promise<{ rendered: boolean }> {
    const { resumeId, workerId } = job.data;

    const resume = await this.resumes.findById(resumeId);
    if (!resume) {
      // Nothing to render (deleted?). Don't fail the job — just no-op.
      this.logger.warn(`resume ${resumeId} not found; skipping render`);
      return { rendered: false };
    }

    // Idempotency: a prior attempt may have already produced the PDF.
    if (resume.renderStatus === "rendered") {
      this.logger.log(`resume ${resumeId} already rendered; skipping`);
      return { rendered: true };
    }

    // Decrypt the worker's real name SERVER-SIDE. Degrade to a name-less render on
    // any failure (rotated key / tampered token) — same as ResumeService. Never log
    // the token, the error detail, or the name.
    let displayName: string | null = null;
    const worker = await this.workers.findById(workerId);
    if (worker?.fullName) {
      try {
        displayName = this.pii.decrypt(worker.fullName);
      } catch {
        this.logger.warn(
          `could not decrypt full_name for worker ${workerId}; rendering a name-less resume`,
        );
      }
    }

    const input = this.buildRenderInput(resume.sourceProfileSnapshot, displayName, resume.templateId);

    let pdf: Buffer | null = null;
    try {
      pdf = await this.renderer.renderPdf(input);
    } catch (err) {
      // The renderer is designed to degrade to null, but guard anyway. Never log
      // the input/name — only a generic reason.
      this.logger.warn(
        `resume ${resumeId} render threw (${err instanceof Error ? err.message : "unknown"}); treating as no-PDF`,
      );
      pdf = null;
    }

    if (!pdf) {
      // No PDF this run (kill-switch off, binary missing, or render failed). Only
      // mark the row 'failed' on the FINAL attempt so retries can still succeed.
      if (this.isFinalAttempt(job) && !this.config.RESUME_RENDER_ENABLED) {
        // Kill-switch off is an expected steady state, not a failure: leave the row
        // 'pending' so it renders once rendering is enabled, rather than marking it failed.
        this.logger.log(`resume ${resumeId} not rendered (render disabled); leaving status pending`);
      } else if (this.isFinalAttempt(job)) {
        await this.resumes.markRenderFailed(resumeId);
        this.logger.warn(`resume ${resumeId} render failed after final attempt; marked failed`);
      }
      return { rendered: false };
    }

    // Object key: opaque UUIDs only (worker + resume + version) — no PII in the
    // path. The key is NOT the security boundary (UUIDs are guessable in theory);
    // a PRIVATE bucket + short-TTL signed URL is. The name lives in the PDF bytes only.
    const objectKey = `resumes/${workerId}/${resumeId}/v${resume.version}.pdf`;
    try {
      await this.storage.uploadPdf(objectKey, pdf);
      await this.resumes.markRendered(resumeId, objectKey);
    } catch (err) {
      // The PDF rendered but upload/persist failed. Let BullMQ retry; only on the
      // FINAL attempt flip the row to 'failed' so it doesn't sit 'pending' forever.
      this.logger.warn(
        `resume ${resumeId} upload/persist failed (${err instanceof Error ? err.message : "unknown"})`,
      );
      if (this.isFinalAttempt(job)) {
        await this.resumes.markRenderFailed(resumeId);
        return { rendered: false };
      }
      throw err;
    }
    this.logger.log(`resume ${resumeId} rendered + uploaded (v${resume.version})`);
    return { rendered: true };
  }

  /** True on the last BullMQ attempt — so terminal failures are marked only once. */
  private isFinalAttempt(job: Job<ResumeRenderJobData>): boolean {
    const maxAttempts = job.opts.attempts ?? 1;
    return job.attemptsMade + 1 >= maxAttempts;
  }

  /**
   * Build the renderer input from the NAME-FREE snapshot + the decrypted name.
   * The snapshot is the stored DraftProfile; re-validate its shape. Phase-1 trade
   * content is empty (TODO: fetch rich trade content once questionnaire output is
   * wired through).
   */
  private buildRenderInput(
    snapshot: unknown,
    displayName: string | null,
    templateId: string | null,
  ): ResumeRenderInput {
    const draft = DraftProfileSchema.parse(snapshot ?? {});
    return {
      templateId,
      displayName,
      canonicalRole: draft.canonical_role_id,
      location: draft.location_preference.preferred_cities[0] ?? null,
      experienceYears: draft.experience.total_years,
      availability: ResumeRenderProcessor.humanizeAvailability(draft.availability.status),
      summary: draft.experience.summary,
      skills: draft.skills,
      machines: draft.machines,
      // Not captured in the DraftProfile snapshot yet (TD24): rich trade content
      // (controllers / education / certifications). Empty regions render to nothing.
      controllers: [],
      education: [],
      certifications: [],
    };
  }

  /** Map the availability enum to a short human-readable phrase (or omit). */
  private static humanizeAvailability(status: string): string | null {
    switch (status) {
      case "immediate":
        return "Available immediately";
      case "notice_period":
        return "On notice period";
      default:
        return null; // not_looking / unknown → omit
    }
  }
}
