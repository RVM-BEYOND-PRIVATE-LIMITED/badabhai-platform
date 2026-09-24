import { Processor, WorkerHost } from "@nestjs/bullmq";
import { HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { RequestContext } from "../common/request-context";
import { WorkersRepository } from "../workers/workers.repository";
import { ProfilesRepository } from "../profiles/profiles.repository";
import { ResumeService } from "./resume.service";
import { ResumeRepository } from "./resume.repository";
import { ConsentRepository } from "../consent/consent.repository";
import { hasActiveConsent } from "../consent/consent-active";
import { RESUME_GENERATE_QUEUE, type ResumeGenerateJobData } from "../queue/queue.constants";

/**
 * Auto-generates a resume off the request path after a profile is confirmed
 * (enqueued by ProfilesService). Idempotent: if the worker already has a resume,
 * skip — confirmation can be re-emitted under retries, and the manual
 * `POST /resume/generate` path may have run first. Tracing ids are carried from
 * the originating request so the generated event stays correlated.
 *
 * ── THE ONE EXCEPTION: AN UPDATE THE WORKER ACCEPTED IN CHAT (ADR-0043) ─────────────────
 *
 * A worker who already has a résumé and says "Haan" to "Resume update kar doon?" is asking for
 * exactly the generation the one-per-worker skip exists to withhold. The skip stays for EVERY
 * other confirm — an "Abhi nahi" followed by the preview's confirm, or a shipped app build
 * confirming a redo, behaves exactly as it did before — and is bypassed only when the PROFILE
 * ROW says the update was accepted (`resume_update_accepted_at`, written by the extraction
 * processor from the session). The row, not the job payload: the app's own confirm can enqueue
 * a job for the same profile first, and it must reach the same answer from the same record.
 *
 * Under the bypass the idempotency is PER PROFILE: a résumé already generated from this profile
 * means this job — or its twin from the other confirm — already did the work.
 */
@Processor(RESUME_GENERATE_QUEUE)
export class ResumeGenerateProcessor extends WorkerHost {
  private readonly logger = new Logger(ResumeGenerateProcessor.name);

  constructor(
    private readonly resumeService: ResumeService,
    private readonly workers: WorkersRepository,
    private readonly profiles: ProfilesRepository,
    private readonly resumes: ResumeRepository,
    // The consent re-check in front of the accepted-update generation — see `process`. Optional
    // so a construction without it compiles; absent, that generation does not run (fail closed).
    private readonly consents?: ConsentRepository,
  ) {
    super();
  }

  async process(job: Job<ResumeGenerateJobData>): Promise<{ skipped: boolean }> {
    const { workerId, profileId, correlationId, requestId } = job.data;
    const ctx: RequestContext = { correlationId, requestId };

    const profile = await this.profiles.findById(profileId);
    const acceptedUpdate =
      profile !== undefined &&
      profile.workerId === workerId &&
      profile.resumeUpdateAcceptedAt != null;

    if (acceptedUpdate) {
      if (await this.resumes.newestForProfile(profileId)) {
        this.logger.log(
          `profile ${profileId} already has its accepted-update resume; skipping auto-generate`,
        );
        return { skipped: true };
      }
      // Re-checked HERE as well as at the confirm: this generation runs with no request from the
      // worker, and a withdrawal between the confirm and this job must stop the model call.
      if (!(await hasActiveConsent(this.consents, workerId, "resume_generation"))) {
        this.logger.warn(
          `accepted-update resume for profile ${profileId} not generated: consent is not active`,
        );
        return { skipped: true };
      }
      try {
        await this.resumeService.generate({ worker_id: workerId, profile_id: profileId }, ctx, {
          systemInitiated: true,
          trigger: "chat_update_accepted",
          // The first attempt charged the worker's daily cap; a retry after a model failure must
          // not charge it again.
          retry: job.attemptsMade > 0,
        });
      } catch (err) {
        // THE CAP'S REFUSAL IS TERMINAL, NEVER RETRIED. A retry is exempt from the per-worker cap
        // (it was charged on attempt one), so letting BullMQ retry a REFUSED first attempt would
        // walk straight past the cap on attempt two. Refused means the update does not happen
        // today; `GET /resume/history` reports it failed once the pending timeout passes.
        if (err instanceof HttpException && err.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
          this.logger.warn(
            `accepted-update resume for profile ${profileId} refused by the daily cap; not retried`,
          );
          return { skipped: true };
        }
        throw err;
      }
      return { skipped: false };
    }

    // Pre-generate idempotency: one resume per worker is enough for the auto path.
    const existing = await this.workers.latestResume(workerId);
    if (existing) {
      this.logger.log(`worker ${workerId} already has a resume; skipping auto-generate`);
      return { skipped: true };
    }

    // System-initiated: skip the per-worker abuse cap (one-per-worker + idempotent),
    // but the global spend backstop still applies.
    await this.resumeService.generate(
      { worker_id: workerId, profile_id: profileId },
      ctx,
      { systemInitiated: true },
    );
    return { skipped: false };
  }
}
