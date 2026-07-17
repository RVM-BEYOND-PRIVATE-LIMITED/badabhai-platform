import { Inject, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { conversationWorkerPrefix } from "@badabhai/validators";
import { SERVER_CONFIG } from "../config/config.module";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { StorageService } from "../storage/storage.service";
import { WorkersRepository } from "../workers/workers.repository";
import { SessionService } from "./session.service";

/**
 * Minimal typed view of the one Redis command the deletion tombstone needs (the
 * cool-down `SET key val EX sec`). The runtime client is ioredis (obtained from the
 * BullMQ queue) — the same idiom OtpService/SessionService use.
 */
interface RedisTombstoneClient {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
}

/**
 * DPDP worker-initiated account deletion orchestration (ADR-0026 Phase 5, decision D4;
 * grace window amended by ADR-0031).
 *
 * ADR-0031: `schedule(workerId, ctx)` / `cancel(workerId, ctx)` manage the 7-day grace
 * marker (`workers.deletion_scheduled_at`) — confirm now SCHEDULES instead of erasing,
 * and the worker can cancel anytime during grace. `execute(workerId)` below is UNCHANGED:
 * it remains the post-grace erasure step, run by the sweep once the marker is overdue.
 *
 * `execute(workerId)` runs BEST-EFFORT-COMPLETE and IDEMPOTENT in a fixed order:
 *   1. revoke all sessions + refresh families (FIRST — a deleted-in-progress worker can
 *      never be re-authenticated);
 *   2. CAPTURE resume object keys + the had_pin/devices_revoked counts, then erase storage
 *      (resume PDFs + archived conversations) — captured BEFORE the DB delete (the cascade
 *      erases generated_resumes, so their opaque object keys must be read first);
 *   3. hard-delete the workers row in a transaction (Postgres cascades PII children and
 *      SET-NULLs the three billing/intent FKs per migration 0030);
 *   4. set a Redis cool-down tombstone on the PII-free phone_hash (fail-OPEN);
 *   5. emit `worker.account_deleted` (PII-FREE: opaque worker id + counts/flags only).
 *
 * FAIL SEMANTICS (D4): a re-run on an already-gone worker is a no-op (findById null → return).
 * A storage hiccup increments storage_objects_failed and CONTINUES — it never aborts the DB
 * erasure (an orphan keyed by an opaque UUID is non-PII-linkable + re-runnable). The DB delete
 * is the atomic identity removal; revoke (step 1) precedes everything so we never half-auth a
 * deleted worker.
 *
 * PRIVACY (CLAUDE.md §2): the OTP code, phone, name, phone_hash derivation, and resume object
 * keys NEVER enter the event, logs, ai_jobs, or audit_logs. Logs carry only an opaque worker_id
 * prefix + counts. The only retained phone derivative is the Redis cool-down KEY value (the
 * keyed, non-reversible HMAC blind index — the same §2-permitted derivative as worker.created).
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly workers: WorkersRepository,
    private readonly sessions: SessionService,
    private readonly storage: StorageService,
    private readonly events: EventsService,
    // Reuse BullMQ's existing Redis connection for the cool-down tombstone (no second client).
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Schedule the worker's erasure after the grace window (ADR-0031 — confirm now
   * SCHEDULES, never erases). IDEMPOTENT: if a deletion is already pending, the EXISTING
   * due time is returned with NO event and NO re-extension — the clock never resets
   * without a cancel. A missing worker row throws the same neutral 401 as the
   * controller's resolvePhone (fail closed, no oracle). Logs the opaque worker id only.
   */
  async schedule(workerId: string, ctx: RequestContext): Promise<{ scheduled_for: string }> {
    const idPrefix = workerId.slice(0, 8);

    const worker = await this.workers.findById(workerId);
    if (!worker) throw new UnauthorizedException("Invalid or expired session");

    if (worker.deletionScheduledAt) {
      this.logger.log(
        `account deletion already scheduled worker=${idPrefix} (idempotent re-confirm)`,
      );
      return { scheduled_for: worker.deletionScheduledAt.toISOString() };
    }

    const scheduledAt = new Date(
      Date.now() + this.config.ACCOUNT_DELETION_GRACE_DAYS * 86_400_000,
    );
    // ATOMIC set-if-not-set: only ONE of two racing confirms owns the transition — the
    // loser falls through to the idempotent re-read (same date back, no re-extension,
    // no double-emit of the strict v1 event).
    const owned = await this.workers.scheduleDeletion(workerId, scheduledAt);
    if (!owned) {
      const current = await this.workers.findById(workerId);
      if (current?.deletionScheduledAt) {
        this.logger.log(
          `account deletion already scheduled worker=${idPrefix} (lost schedule race — idempotent)`,
        );
        return { scheduled_for: current.deletionScheduledAt.toISOString() };
      }
      // Row vanished under us (erased concurrently) — same neutral 401 as the guard path.
      throw new UnauthorizedException("Invalid or expired session");
    }

    // PII-FREE schedule record: opaque worker id + the due timestamp only. The event is
    // the DPDP transparency record of the schedule — if it cannot be written, COMPENSATE
    // by clearing the marker and failing the request (state and spine never diverge; the
    // worker's retry re-schedules and re-emits).
    try {
      await this.events.emit({
        event_name: "worker.deletion_scheduled",
        actor: { actor_type: "worker", actor_id: workerId },
        subject: { subject_type: "worker", subject_id: workerId },
        payload: { worker_id: workerId, scheduled_for: scheduledAt.toISOString() },
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    } catch (err) {
      await this.workers.cancelDeletion(workerId).catch(() => undefined); // best-effort undo
      this.logger.warn(`deletion_scheduled emit failed worker=${idPrefix}; schedule rolled back`);
      throw err;
    }

    this.logger.log(`account deletion scheduled worker=${idPrefix}`);
    return { scheduled_for: scheduledAt.toISOString() };
  }

  /**
   * Cancel a pending deletion during grace (ADR-0031). IDEMPOTENT: a missing row or
   * nothing pending is a clean no-op ({ cancelled: false }, NO event) — cancel is a
   * purely recoverable action, so it carries no step-up gate and no oracle. Logs the
   * opaque worker id only.
   */
  async cancel(workerId: string, ctx: RequestContext): Promise<{ cancelled: boolean }> {
    const idPrefix = workerId.slice(0, 8);

    // Read the due time FIRST — RETURNING sees the post-update row, and the compensation
    // below needs the previous value. The read is not the guard; the conditional flip is.
    const before = await this.workers.findById(workerId);
    const previousDueAt = before?.deletionScheduledAt ?? null;

    // ATOMIC clear-if-set: the conditional UPDATE both checks and flips the marker, so a
    // cancel racing another cancel (or the sweep at the due boundary) flips it exactly
    // once — the event below is emitted ONLY by the call that owned the flip (never a
    // false `deletion_cancelled` after an erasure, never a double-emit).
    const flipped = await this.workers.cancelDeletion(workerId);
    if (!flipped) {
      this.logger.log(`account deletion cancel no-op worker=${idPrefix} (nothing pending)`);
      return { cancelled: false };
    }

    // PII-FREE cancel record: the opaque worker id only (what was cancelled and when it
    // was due is recoverable from the paired worker.deletion_scheduled event). Spine
    // consistency: if the event cannot be written, COMPENSATE by restoring the marker to
    // its previous due time (set-if-null restore — a concurrent re-confirm wins harmlessly)
    // and failing the request; the worker's retry re-cancels and re-emits.
    try {
      await this.events.emit({
        event_name: "worker.deletion_cancelled",
        actor: { actor_type: "worker", actor_id: workerId },
        subject: { subject_type: "worker", subject_id: workerId },
        payload: { worker_id: workerId },
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    } catch (err) {
      if (previousDueAt) {
        await this.workers.scheduleDeletion(workerId, previousDueAt).catch(() => undefined);
      }
      this.logger.warn(`deletion_cancelled emit failed worker=${idPrefix}; cancel rolled back`);
      throw err;
    }

    this.logger.log(`account deletion cancelled worker=${idPrefix}`);
    return { cancelled: true };
  }

  /**
   * Erase a worker's account. Idempotent + best-effort-complete (see class doc). Returns
   * silently; the durable record is the `worker.account_deleted` event.
   */
  async execute(workerId: string): Promise<void> {
    const idPrefix = workerId.slice(0, 8);

    // Load the worker FIRST so a re-run on an already-deleted worker is a clean no-op (the
    // row is gone → nothing to do). We also need the phone_hash for the tombstone (step 4).
    const worker = await this.workers.findById(workerId);
    if (!worker) {
      this.logger.log(`account deletion no-op worker=${idPrefix} (already gone)`);
      return;
    }
    const phoneHash = worker.phoneHash;

    // 1. Revoke ALL sessions + refresh families FIRST. revokeAll returns the count of session
    // RECORDS actually deleted — use it directly as sessions_revoked (best-effort: a Redis
    // error inside revokeAll yields 0, which is the honest derivable count).
    const sessionsRevoked = await this.sessions.revokeAll(workerId);

    // 2a. CAPTURE pre-delete facts the cascade would otherwise erase: resume object keys,
    // voice-note audio keys, whether a PIN existed, and the device count.
    const resumeKeys = await this.workers.listResumeStorageKeys(workerId);
    const voiceKeys = await this.workers.listVoiceStorageKeys(workerId);
    const hadPin = await this.workers.hasCredentials(workerId);
    const devicesRevoked = await this.workers.countDevices(workerId);

    // 2b. Erase storage BEFORE the DB delete. A single object-delete failure increments the
    // failed counter and CONTINUES (never aborts the erasure — D4). Resume PDFs are keyed by
    // opaque UUIDs (read above); archived conversations are prefix-scoped by worker.
    let storageDeleted = 0;
    let storageFailed = 0;

    for (const key of resumeKeys) {
      try {
        await this.storage.deletePdf(key, this.config.RESUMES_BUCKET);
        storageDeleted += 1;
      } catch (err) {
        storageFailed += 1;
        // PII-free: object keys are opaque UUIDs; log the reason class only, never the key.
        this.logger.warn(
          `account deletion resume-object delete failed worker=${idPrefix} (reason: ${
            err instanceof Error ? err.message : String(err)
          })`,
        );
      }
    }

    // 2c. Erase raw AUDIO blobs (voice notes) — security Finding 1 LAUNCH-GATE seam. The
    // cascade deletes voice_notes rows (transcript_text/transcript_english = raw PII), but the
    // audio blob at storage_path lives in object storage and would ORPHAN + survive a DSAR
    // erasure once real audio storage lands. Voice upload is a Phase-1 placeholder today: the
    // client supplies storage_path but there is NO backend audio bucket, so VOICE_NOTES_BUCKET
    // is unset and this no-ops (WIRED-BUT-DORMANT). When a real audio bucket lands, audio MUST
    // live in VOICE_NOTES_BUCKET (or under conversationWorkerPrefix) so this erases it. The raw
    // storage_path is itself PII-adjacent (worker-scoped path) — keep it OUT of logs (reason
    // class + opaque worker prefix only, exactly like the resume loop).
    if (this.config.VOICE_NOTES_BUCKET) {
      for (const key of voiceKeys) {
        try {
          await this.storage.deletePdf(key, this.config.VOICE_NOTES_BUCKET);
          storageDeleted += 1;
        } catch (err) {
          storageFailed += 1;
          this.logger.warn(
            `account deletion voice-object delete failed worker=${idPrefix} (reason: ${
              err instanceof Error ? err.message : String(err)
            })`,
          );
        }
      }
    }

    // 2d. Erase the profile PHOTO objects (ADR-0032 — a face photo is a high-sensitivity PII
    // class). PREFIX sweep rather than the single stored key: it also catches orphans
    // (uploaded-but-never-confirmed) and superseded objects whose best-effort replace-delete
    // failed. Gated on the bucket exactly like the voice leg (WIRED-BUT-DORMANT while unset —
    // and while unset no photo can have been uploaded, so there is nothing to orphan). The
    // worker row was captured at step 0, so this needs no extra pre-delete read.
    if (this.config.WORKER_PHOTOS_BUCKET) {
      try {
        const photosDeleted = await this.storage.deleteByPrefix(
          `photos/${workerId}/`,
          this.config.WORKER_PHOTOS_BUCKET,
        );
        storageDeleted += photosDeleted;
      } catch (err) {
        storageFailed += 1;
        this.logger.warn(
          `account deletion photo-prefix delete failed worker=${idPrefix} (reason: ${
            err instanceof Error ? err.message : String(err)
          })`,
        );
      }
    }

    try {
      const conversationsDeleted = await this.storage.deleteByPrefix(
        conversationWorkerPrefix(workerId),
        this.config.CONVERSATIONS_BUCKET,
      );
      storageDeleted += conversationsDeleted;
    } catch (err) {
      storageFailed += 1;
      this.logger.warn(
        `account deletion conversation-prefix delete failed worker=${idPrefix} (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }

    // 3. Hard-delete the workers row (transactional cascade). This is the atomic PII removal.
    // A false return means a concurrent run already deleted it — still proceed to tombstone +
    // event (the captured counts above remain the best available record).
    const deleted = await this.workers.hardDelete(workerId);
    if (!deleted) {
      this.logger.log(`account deletion worker=${idPrefix} already removed by a concurrent run`);
    }

    // 4. Tombstone: set the Redis cool-down on the PII-free phone_hash. FAIL-OPEN — a Redis
    // error here must NOT abort the already-completed erasure (the PII is gone). Skip when the
    // cool-down is disabled (0). The KEY value is the keyed HMAC blind index — the only retained
    // phone derivative (§2-permitted, never reversible to a number).
    if (this.config.ACCOUNT_DELETION_COOLDOWN_SECONDS > 0) {
      try {
        const redis = (await this.queue.client) as unknown as RedisTombstoneClient;
        await redis.set(
          `deleted_phone:${phoneHash}`,
          "1",
          "EX",
          this.config.ACCOUNT_DELETION_COOLDOWN_SECONDS,
        );
      } catch (err) {
        // Best-effort anti-abuse cool-down; a flush only re-opens normal registration.
        this.logger.warn(
          `account deletion tombstone set failed worker=${idPrefix} (fail-open; reason: ${
            err instanceof Error ? err.message : String(err)
          })`,
        );
      }
    }

    // 5. Emit the durable, PII-FREE deletion record AFTER the DB delete (actor_id is opaque,
    // no FK to the gone row). Counts/flags only — never a phone/name/key/OTP.
    await this.events.emit({
      event_name: "worker.account_deleted",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      payload: {
        worker_id: workerId,
        sessions_revoked: sessionsRevoked,
        devices_revoked: devicesRevoked,
        storage_objects_deleted: storageDeleted,
        storage_objects_failed: storageFailed,
        had_pin: hadPin,
      },
    });

    this.logger.log(
      `account deletion complete worker=${idPrefix} sessions=${sessionsRevoked} devices=${devicesRevoked} storage_deleted=${storageDeleted} storage_failed=${storageFailed} had_pin=${hadPin}`,
    );
  }
}
