import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsService } from "../events/events.service";
import { WorkersRepository } from "./workers.repository";
import { toProfileSummary } from "./profile-summary.mapper";
import type {
  WorkerProfileSummary,
  WorkerResumeFields,
  UpdateResumePrefsDto,
} from "./workers.dto";

/**
 * Worker write-side logic (identity) + the worker SELF-view summary read.
 * Plain read-only ops queries stay on the repository; mutations that touch PII
 * go through here so encryption + the event are never bypassed, and the
 * profile-summary read goes through here because it needs mapping (taxonomy
 * display-name resolution + strength recompute), not a raw row.
 */
@Injectable()
export class WorkersService {
  private readonly logger = new Logger(WorkersService.name);

  constructor(
    private readonly workers: WorkersRepository,
    private readonly pii: PiiCryptoService,
    private readonly events: EventsService,
  ) {}

  /**
   * Record the worker's real name. The name is PII (TD21): it is encrypted at
   * rest (AES-256-GCM, same as phone_e164) and NEVER logged, returned, or placed
   * in an event — only the fact that a name was recorded is emitted. The plaintext
   * name does not leave this method. Returns `{ worker_id }` only.
   */
  async setFullName(
    workerId: string,
    fullName: string,
    ctx: RequestContext,
  ): Promise<{ worker_id: string }> {
    const worker = await this.workers.findById(workerId);
    if (!worker) throw new NotFoundException(`Worker ${workerId} not found`);

    // Encrypt before it touches the DB — a plaintext name is never persisted.
    const encrypted = this.pii.encrypt(fullName);
    await this.workers.updateFullName(workerId, encrypted);

    // PII-free signal: carries only worker_id (the name stays in workers.full_name).
    await this.events.emit({
      event_name: "worker.name_recorded",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      payload: { worker_id: workerId },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    this.logger.log(`full_name recorded (encrypted) for worker ${workerId}`); // never logs the name
    return { worker_id: workerId };
  }

  /**
   * Worker SELF-view profile summary (TD54 — the worker-app home "my profile"
   * card). Projects the LATEST `worker_profiles` row via the pure
   * {@link toProfileSummary} mapper: canonical trade ids + resolved display
   * name, first preferred city, and a strength recomputed on read
   * (countFields-equivalent — deliberately never stored). No profile row yet →
   * the `"none"` summary, not a 404 (the app renders "complete your profile").
   *
   * NO PII: only the profile row is read — the worker's name/phone never enter
   * this path (returning the name is an OPEN §2 escalation, see
   * docs/worker-profile-summary-spec.md).
   *
   * DELIBERATELY NO EVENT: a read-only self-view is not a material state change
   * (CLAUDE.md §1 — the event spine records state changes, not reads), so this
   * emits nothing.
   */
  async getProfileSummary(workerId: string): Promise<WorkerProfileSummary> {
    const profile = await this.workers.latestProfile(workerId);
    return toProfileSummary(profile ?? null);
  }

  /**
   * The worker-editable resume "safe fields" (GET /workers/me/resume-fields). Unlike
   * the faceless profile-summary, this DOES decrypt and return the worker's OWN name
   * so they can correct its spelling — a self-read of one's own name is not a
   * cross-actor leak (§2 ruling recorded 2026-07-14, TD21). The plaintext name is
   * returned to the owner over TLS only; it never enters an event, log, ai_jobs, or
   * LLM input — the name is captured in a SEPARATE step precisely so it never reaches
   * an LLM. `full_name` is null until set.
   *
   * Decrypt failure (corrupt/wrong-key/legacy-plaintext row) DEGRADES to a name-less
   * response — never a thrown error that could 500 the edit screen or embed PII —
   * mirroring the payer-disclosure path (resume-disclosure.service.ts). Fails closed.
   *
   * DELIBERATELY NO EVENT: a read-only self-view is not a state change (§1).
   */
  async getResumeFields(workerId: string): Promise<WorkerResumeFields> {
    const worker = await this.workers.findById(workerId);
    if (!worker) throw new NotFoundException(`Worker ${workerId} not found`);

    let fullName: string | null = null;
    if (worker.fullName) {
      try {
        fullName = this.pii.decrypt(worker.fullName);
      } catch {
        // Degrade name-less; never log the ciphertext/key/plaintext (§2).
        this.logger.warn(`could not decrypt full_name for worker ${workerId}; name-less resume fields`);
      }
    }

    return {
      full_name: fullName,
      show_photo: worker.resumeShowPhoto,
      night_shift_ready: worker.resumeNightShiftReady,
    };
  }

  /**
   * Update the worker's resume display prefs (PATCH /workers/me/resume-prefs). Only
   * the provided flags are written; the event carries the RESULTING values of both
   * flags (read back from the updated row) — PII-free booleans only.
   */
  async updateResumePrefs(
    workerId: string,
    dto: UpdateResumePrefsDto,
    ctx: RequestContext,
  ): Promise<{ worker_id: string }> {
    const worker = await this.workers.findById(workerId);
    if (!worker) throw new NotFoundException(`Worker ${workerId} not found`);

    const updated = await this.workers.updateResumePrefs(workerId, {
      resumeShowPhoto: dto.show_photo,
      resumeNightShiftReady: dto.night_shift_ready,
    });
    if (!updated) throw new NotFoundException(`Worker ${workerId} not found`);

    await this.events.emit({
      event_name: "worker.resume_prefs_updated",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      payload: {
        worker_id: workerId,
        show_photo: updated.resumeShowPhoto,
        night_shift_ready: updated.resumeNightShiftReady,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    this.logger.log(`resume prefs updated for worker ${workerId}`);
    return { worker_id: workerId };
  }
}
