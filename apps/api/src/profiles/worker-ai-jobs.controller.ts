import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from "@nestjs/common";
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ConsentGuard } from "../auth/consent.guard";
import { AiJobsRepository } from "./ai-jobs.repository";
import type { WorkerAiJobResponse } from "./ai-jobs.dto";

/**
 * Worker-facing poll for an async AI job — the profiling and voice-transcription
 * flows' only way to learn that their work finished.
 *
 * WHY THIS EXISTS SEPARATELY FROM `AiJobsController`. The worker app polled
 * `GET /ai-jobs/:id` with no credential at all. Commit 922af4d1 put that controller
 * behind `InternalServiceGuard` — correctly, it is an ops route — and the app has
 * 401'd on every poll since, breaking profile extraction and voice transcription in
 * any real build. The fix is a worker principal of its own, NOT a relaxation of the
 * ops guard, which `scripts/prod-canary.mjs:88-89` probes unauthenticated and
 * requires to keep rejecting.
 *
 * It is a DEDICATED controller, not a method on `AiJobsController`, and that is load-
 * bearing: guards union class-level with method-level, so a worker route added there
 * would inherit `InternalServiceGuard`, get pulled into `OPS_ROUTES` by
 * `canary-coverage.test.ts`, and then fail prod-canary stage 4 — which sends the ops
 * token and requires a non-401. `NotificationsController` is the proven precedent for
 * a `@Controller("workers/me/<thing>")` of its own.
 *
 * AUTHZ. `WorkerAuthGuard` then `ConsentGuard` (the posture of all 10 existing
 * `/workers/me/*` routes; profiling data is exactly what consent gates). The worker
 * comes from `@CurrentWorker` — the bearer token — never a path or body id.
 * Ownership is enforced in the query (`findByIdForWorker`), and a job belonging to
 * someone else returns the SAME 404 as a job that does not exist, so the uuid is not
 * an enumeration oracle.
 *
 * PROJECTION. Three keys, listed explicitly. `output_ref` is flattened rather than
 * passed through, so a future key added to that jsonb column cannot leak here by
 * accident. Deliberately WITHHELD, all of which the ops route still returns:
 *   - `ai_usage.*` — `cost_inr` is per-worker unit economics, `model_name` fingerprints
 *     the vendor for prompt-injection targeting, and `real_call` discloses per job
 *     whether a real LLM ran (the exact posture TD67/TD81 stopped disclosing).
 *   - `error_message` — free-form `err.message`; on an infrastructure outage it can
 *     carry `<db-host>:<port>`. The worker app never renders it (it is dropped in
 *     `failure_mapper.dart`), so it buys nothing and discloses infrastructure.
 *   - `id`, `job_type`, `created_at`, `updated_at` — the client already holds the id
 *     and knows what it enqueued; nothing reads them.
 *
 * A read → NO event emitted (§1). `no-store` because the response is worker-scoped
 * and its whole purpose is to be freshly polled.
 */
@Controller("workers/me/ai-jobs")
export class WorkerAiJobsController {
  constructor(private readonly aiJobs: AiJobsRepository) {}

  @Get(":id")
  @Header("Cache-Control", "no-store")
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async get(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<WorkerAiJobResponse> {
    const job = await this.aiJobs.findByIdForWorker(id, worker.id);
    // NOT FOUND and NOT YOURS are the same answer on purpose — see the AUTHZ note.
    if (!job) throw new NotFoundException(`AI job ${id} not found`);

    const ref = (job.outputRef ?? {}) as Record<string, unknown>;
    return {
      status: job.status,
      profile_id: typeof ref.profile_id === "string" ? ref.profile_id : null,
      voice_note_id: typeof ref.voice_note_id === "string" ? ref.voice_note_id : null,
    };
  }
}
