import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { WorkersRepository } from "../workers/workers.repository";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { StorageService } from "../storage/storage.service";
import { ResumeRepository } from "./resume.repository";
import { ResumeRenderer } from "./resume-renderer.service";
import { buildResumeRenderInput } from "./resume-render-input";
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
    //
    // ADR-0032 / TD77: `force` overrides this for a PRESENTATION-only re-render
    // (photo added/replaced/removed, or the show_photo pref flipped after the
    // first render). Without the override the photo could never reach an
    // already-rendered PDF. A forced run re-renders in place — same version, same
    // object key — so no new version is minted and the old PDF stays downloadable
    // until the fresh one overwrites it.
    const wasRendered = resume.renderStatus === "rendered";
    if (wasRendered && !job.data.force) {
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

    // ADR-0032 — the worker's profile photo, embedded ONLY on the worker's OWN
    // resume and ONLY when the worker's show_photo pref is on. Fetched as bytes
    // (WeasyPrint renders from stdin with no network — a data: URI is the only
    // hermetic embed). Degrade photo-less on ANY failure: the photo must never
    // cost the worker their PDF. Never log the key or the bytes.
    let photoDataUri: string | null = null;
    const photoBucket = this.config.WORKER_PHOTOS_BUCKET;
    if (photoBucket && worker?.resumeShowPhoto && worker.photoStorageKey) {
      try {
        const bytes = await this.storage.downloadObject(worker.photoStorageKey, photoBucket);
        if (bytes && bytes.length > 0 && bytes.length <= 2 * 1024 * 1024) {
          // MAGIC-BYTE check (bb-security-review L-2): the stored content-type is
          // client-declared at PUT, so verify the actual bytes are a real JPEG
          // (FF D8 FF) or PNG (89 50 4E 47) and SKIP the embed otherwise — arbitrary
          // bytes must never reach WeasyPrint as an "image".
          const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
          const isPng =
            bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
          if (isJpeg || isPng) {
            const mime = isPng ? "image/png" : "image/jpeg";
            photoDataUri = `data:${mime};base64,${bytes.toString("base64")}`;
          }
        }
      } catch {
        this.logger.warn(
          `could not fetch profile photo for worker ${workerId}; rendering photo-less`,
        );
      }
    }

    const input = buildResumeRenderInput(
      resume.sourceProfileSnapshot,
      displayName,
      resume.templateId,
      photoDataUri,
    );

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
      if (this.isFinalAttempt(job) && wasRendered && job.data.failClosed) {
        // TD77 REMOVE direction: the existing PDF embeds the face the worker asked us
        // to erase, so keeping it in service would keep serving erased PII (§2/DPDP).
        // Take it out of service — a 409 beats serving a removed face.
        //
        // THIS MUST BE TESTED BEFORE THE KILL-SWITCH BRANCH BELOW. Erasure outranks the
        // kill-switch: when RESUME_RENDER_ENABLED is off there is no way to re-render the
        // face OFF the PDF, which makes it MORE important to stop serving it, not less.
        // Ordering this after the kill-switch check silently shadowed `failClosed` and
        // left the row 'rendered' (i.e. still serving the erased face) — and it never
        // self-heals, because a later DELETE /workers/me/photo skips the re-render once
        // show_photo is already off. Gated on `wasRendered`: with no PDF on file there is
        // no face to erase, so a not-yet-rendered row belongs to the branches below.
        await this.resumes.markRenderFailed(resumeId);
        this.logger.warn(
          `resume ${resumeId} fail-closed re-render produced no PDF; marked failed rather than serve erased PII`,
        );
      } else if (this.isFinalAttempt(job) && wasRendered) {
        // TD77: a FORCED re-render over an ALREADY-GOOD PDF failed. That PDF is
        // still in storage and still valid, so the row must STAY 'rendered' —
        // marking it 'failed' would 409 a resume the worker could download a second
        // ago (i.e. changing their photo would cost them their resume). Degrade
        // silently: keep serving the existing PDF; the photo just isn't on it yet.
        // (The REMOVE direction never reaches here — it is handled above.)
        this.logger.warn(
          `resume ${resumeId} forced re-render produced no PDF; keeping the existing rendered PDF`,
        );
      } else if (this.isFinalAttempt(job) && !this.config.RESUME_RENDER_ENABLED) {
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
        // TD77: same rule as the no-PDF path — NEVER downgrade a resume that already
        // had a good PDF. A failed upload leaves the previous object intact (the key
        // is unchanged), so the row stays 'rendered' and the old PDF keeps serving.
        // In the REMOVE direction we still fail CLOSED: that stale PDF carries the
        // face the worker erased, so a 409 beats serving it.
        if (!wasRendered || job.data.failClosed) await this.resumes.markRenderFailed(resumeId);
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
}
