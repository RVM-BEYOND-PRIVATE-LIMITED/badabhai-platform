import { Inject, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { WORKER_FEEDBACK_ATTACHMENT_PREFIX } from "@badabhai/types";
import { conversationWorkerPrefix, uuidSchema } from "@badabhai/validators";
import { SERVER_CONFIG } from "../config/config.module";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { ChatTranscriptBuffer } from "../chat/chat-transcript.buffer";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { StorageService } from "../storage/storage.service";
import { WorkersRepository } from "../workers/workers.repository";
import { ErasureAuditBuilder } from "./erasure-audit";
import { ErasureAuditRepository } from "./erasure-audit.repository";
import { SessionService } from "./session.service";

/**
 * Minimal typed view of the Redis commands the erasure needs: the cool-down tombstone
 * (`SET key val EX sec`) and the in-flight transcript purge (`DEL`). The runtime client
 * is ioredis (obtained from the BullMQ queue) — the same idiom OtpService/SessionService
 * use.
 */
interface RedisDeletionClient {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
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
 *      erases generated_resumes, so their opaque object keys must be read first), recording
 *      EVERY LEG as it runs (TD58 / #712);
 *   2f. write the PII-free `audit_logs` row proving what each store reported — BEFORE the hard
 *      delete, so a crash mid-erasure still leaves evidence. Fail-OPEN: it is evidence, not a
 *      gate, and aborting here would destroy the objects and record nothing;
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
    // TD58's "provably" (#712): the durable, PII-free record of what each store actually
    // reported. Write-only, and NOT the event — see `ErasureAuditRepository`.
    private readonly erasureAudit: ErasureAuditRepository,
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

    const scheduledAt = new Date(Date.now() + this.config.ACCOUNT_DELETION_GRACE_DAYS * 86_400_000);
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
    // FAIL CLOSED ON THE ID BEFORE ANY DESTRUCTIVE PREFIX IS BUILT.
    //
    // This method now composes THREE storage prefixes from `workerId` — voice,
    // photos and conversations — and each one deletes everything beneath it.
    // Their safety currently rests on facts held in other files: the only
    // caller reads `workers.id` (a `uuid` column), and the `if (!worker)`
    // guard below rejects an id no row matches. That is true today and cheap
    // to lose — an admin or DSAR endpoint taking a worker id from a request
    // body would inherit a raw interpolation into a delete-by-prefix.
    // `conversationWorkerPrefix` already parses for exactly this reason; this
    // extends the same guarantee to the other two legs.
    uuidSchema.parse(workerId);
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
    // Chat session ids, for the Redis transcript purge at step 2e. MUST be read here:
    // the hard delete cascades `chat_sessions`, and the buffer is keyed by session id
    // with no worker index in Redis — after the delete the keys are unreachable.
    const chatSessionIds = await this.workers.listChatSessionIds(workerId);

    // 2b. Erase storage BEFORE the DB delete. A single object-delete failure increments the
    // failed counter and CONTINUES (never aborts the erasure — D4). Resume PDFs are keyed by
    // opaque UUIDs (read above); archived conversations are prefix-scoped by worker.
    // EVERY LEG IS RECORDED AS IT RUNS (TD58 / #712). The two counters below are still the event
    // payload's — unchanged, invariant #8 — but they cannot say WHICH store failed, and they
    // cannot tell "we swept and it was empty" from "we never swept because the bucket is
    // unconfigured". Both readings look like `0`, and only one of them is evidence.
    const audit = new ErasureAuditBuilder();
    let resumesDeleted = 0;
    let resumesFailed = 0;

    for (const key of resumeKeys) {
      try {
        await this.storage.deletePdf(key, this.config.RESUMES_BUCKET);
        resumesDeleted += 1;
      } catch (err) {
        resumesFailed += 1;
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
    if (resumesFailed > 0)
      audit.failed("resume_objects", "by-row", resumeKeys.length, resumesDeleted);
    else audit.swept("resume_objects", "by-row", resumeKeys.length, resumesDeleted);

    if (this.config.VOICE_NOTES_BUCKET) {
      let voiceDeleted = 0;
      let voiceFailed = 0;
      for (const key of voiceKeys) {
        try {
          await this.storage.deletePdf(key, this.config.VOICE_NOTES_BUCKET);
          voiceDeleted += 1;
        } catch (err) {
          voiceFailed += 1;
          this.logger.warn(
            `account deletion voice-object delete failed worker=${idPrefix} (reason: ${
              err instanceof Error ? err.message : String(err)
            })`,
          );
        }
      }
      if (voiceFailed > 0) audit.failed("voice_objects", "by-row", voiceKeys.length, voiceDeleted);
      else audit.swept("voice_objects", "by-row", voiceKeys.length, voiceDeleted);

      // …AND THE ORPHANS THE LOOP ABOVE STRUCTURALLY CANNOT SEE.
      //
      // `voiceKeys` comes from `SELECT storage_path FROM voice_notes WHERE worker_id = $1`, so it
      // enumerates audio we hold a ROW for. Upload is two steps: `POST /voice/upload-url` mints a
      // signed PUT into `voice-notes/{workerId}/{uuid}.m4a`, and a SEPARATE `POST /voice/upload`
      // inserts the row. A client that completes the PUT and never makes the second call — app
      // killed, network dropped, or simply choosing not to — leaves raw worker audio in the
      // bucket that no row points at. That object is invisible to the query, so it survived a
      // DSAR erasure indefinitely. The DPDP obligation is to erase the worker's personal data,
      // not the rows we happen to have indexed it by.
      //
      // ADDED BESIDE the per-row loop rather than replacing it, which matters: the minted-key
      // shape guard (`voice.service.ts`) only constrains rows created after it landed, so a
      // legacy `storage_path` outside `voice-notes/{workerId}/` would stop being erased if the
      // loop went away. The two sets overlap harmlessly — deleting an already-deleted key is a
      // no-op, and `deleteByPrefix` returns 0 for an empty prefix.
      //
      // This is the same sweep the PHOTO leg below already does, and its comment already gives
      // the reason. The voice leg simply never got it.
      const voicePrefix = `voice-notes/${workerId}/`;
      try {
        const orphansDeleted = await this.storage.deleteByPrefix(
          voicePrefix,
          this.config.VOICE_NOTES_BUCKET,
        );
        audit.swept("voice_prefix", voicePrefix, 1, orphansDeleted);
      } catch (err) {
        audit.failed("voice_prefix", voicePrefix, 1);
        this.logger.warn(
          `account deletion voice-prefix delete failed worker=${idPrefix} (reason: ${
            err instanceof Error ? err.message : String(err)
          })`,
        );
      }
    } else {
      // NEVER RAN, and the record says so rather than reporting an empty sweep. While
      // VOICE_NOTES_BUCKET is unset no audio can have been stored, so this is not a gap — but
      // "we looked and found nothing" and "we never looked" are different claims, and only the
      // first is evidence a DSAR request was honoured.
      audit.skipped("voice_objects", "by-row");
      audit.skipped("voice_prefix", `voice-notes/${workerId}/`);
    }

    // 2d. Erase the profile PHOTO objects (ADR-0032 — a face photo is a high-sensitivity PII
    // class). PREFIX sweep rather than the single stored key: it also catches orphans
    // (uploaded-but-never-confirmed) and superseded objects whose best-effort replace-delete
    // failed. Gated on the bucket exactly like the voice leg (WIRED-BUT-DORMANT while unset —
    // and while unset no photo can have been uploaded, so there is nothing to orphan). The
    // worker row was captured at step 0, so this needs no extra pre-delete read.
    const photoPrefix = `photos/${workerId}/`;
    if (this.config.WORKER_PHOTOS_BUCKET) {
      try {
        const photosDeleted = await this.storage.deleteByPrefix(
          photoPrefix,
          this.config.WORKER_PHOTOS_BUCKET,
        );
        audit.swept("photo_prefix", photoPrefix, 1, photosDeleted);
      } catch (err) {
        audit.failed("photo_prefix", photoPrefix, 1);
        this.logger.warn(
          `account deletion photo-prefix delete failed worker=${idPrefix} (reason: ${
            err instanceof Error ? err.message : String(err)
          })`,
        );
      }
    } else {
      audit.skipped("photo_prefix", photoPrefix);
    }

    // 2d-bis. Erase the FEEDBACK ATTACHMENT objects (#1191). A worker photographs what they are
    // reporting — a payslip, a gate pass, a supervisor — so these bytes are personal data in the
    // same class as the `message` they arrived with, and the cascade that erases the row does
    // NOT touch object storage.
    //
    // A PREFIX SWEEP, AND HERE IT IS LOAD-BEARING RATHER THAN BELT-AND-BRACES. The photo leg
    // above has a stored key it could have deleted instead; this feature has NO confirm step, so
    // an object uploaded to a minted slot whose submission was never sent, or was rejected by the
    // ownership check, is referenced by no row at all. The prefix is the only thing that knows
    // about it — which is exactly why the mint scopes the key by worker
    // (`feedback-attachments/{workerId}/{uuid}.jpg`) rather than using a flat namespace.
    //
    // Gated on the bucket like both legs above (WIRED-BUT-DORMANT while unset — and while unset
    // the mint 503s, so nothing can have been uploaded to orphan). The prefix is built from the
    // shared constant, not a local literal: a drifted copy here would sweep nothing and report a
    // successful erasure, which is the one failure mode a DSAR record must never have.
    const feedbackAttachmentPrefix = `${WORKER_FEEDBACK_ATTACHMENT_PREFIX}/${workerId}/`;
    if (this.config.WORKER_FEEDBACK_ATTACHMENTS_BUCKET) {
      try {
        const attachmentsDeleted = await this.storage.deleteByPrefix(
          feedbackAttachmentPrefix,
          this.config.WORKER_FEEDBACK_ATTACHMENTS_BUCKET,
        );
        audit.swept("feedback_attachment_prefix", feedbackAttachmentPrefix, 1, attachmentsDeleted);
      } catch (err) {
        audit.failed("feedback_attachment_prefix", feedbackAttachmentPrefix, 1);
        this.logger.warn(
          `account deletion feedback-attachment-prefix delete failed worker=${idPrefix} (reason: ${
            err instanceof Error ? err.message : String(err)
          })`,
        );
      }
    } else {
      // "We looked and found nothing" and "we never looked" are different claims, and only the
      // first is evidence a DSAR request was honoured — the voice leg's own note.
      audit.skipped("feedback_attachment_prefix", feedbackAttachmentPrefix);
    }

    const conversationPrefix = conversationWorkerPrefix(workerId);
    try {
      const conversationsDeleted = await this.storage.deleteByPrefix(
        conversationPrefix,
        this.config.CONVERSATIONS_BUCKET,
      );
      audit.swept("conversation_prefix", conversationPrefix, 1, conversationsDeleted);
    } catch (err) {
      audit.failed("conversation_prefix", conversationPrefix, 1);
      this.logger.warn(
        `account deletion conversation-prefix delete failed worker=${idPrefix} (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }

    // 2e. Purge IN-FLIGHT interview transcripts from Redis. An interview that never
    // completed was never flushed to Postgres, so the cascade at step 3 erases nothing of
    // it — but `chat:transcript:<sessionId>` holds the worker's words VERBATIM and
    // un-redacted (see BufferedMessage.text: "their actual words, un-redacted"). Before
    // the buffer existed those words landed in `chat_messages` on every turn and were
    // cascade-deleted; buffering moved a raw-PII store OUTSIDE the erasure path, so it has
    // to be enrolled explicitly or a DSAR erasure is incomplete for up to the idle TTL.
    //
    // Keyed through `ChatTranscriptBuffer.key` rather than a local template so the format
    // has ONE definition — a drifted copy here would silently purge nothing.
    //
    // Fail-OPEN, exactly like the tombstone: a Redis outage must not abort an erasure that
    // has already destroyed the storage objects. The residual then expires by TTL. Counted
    // into storageFailed so the emitted event still reflects an incomplete erasure.
    if (chatSessionIds.length > 0) {
      try {
        const redis = (await this.queue.client) as unknown as RedisDeletionClient;
        const dropped = await redis.del(
          ...chatSessionIds.map((id) => ChatTranscriptBuffer.key(id)),
        );
        audit.swept("transcript_buffer", "chat:transcript:*", chatSessionIds.length, dropped);
      } catch (err) {
        audit.failed("transcript_buffer", "chat:transcript:*", chatSessionIds.length);
        // Session ids are opaque uuids, but the transcript they key is raw PII — log the
        // reason class and the opaque worker prefix only, never the ids.
        this.logger.warn(
          `account deletion transcript-buffer purge failed worker=${idPrefix} (fail-open; ` +
            `reason: ${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }

    // THE VERDICT, derived from the legs rather than accumulated beside them, so "was this
    // erasure complete" has exactly one answer. The two counters the event payload has always
    // carried fall out of it unchanged — invariant #8 holds, and they can no longer disagree
    // with the record written next to them.
    const erasure = audit.build();
    const storageDeleted = erasure.objects_deleted;
    const storageFailed = erasure.objects_failed;

    // 2f. THE PROOF (TD58 / #712). Written BEFORE the hard delete for the same reason the
    // storage sweeps run first: if this process dies here, the row already says what was
    // erased, and a re-run is a clean no-op that writes a second, honest row. Recording it
    // AFTER would leave the one case that most needs evidence — a crash mid-erasure — with
    // none. Fail-OPEN like the tombstone: an audit-write failure must not abort an erasure
    // that has already destroyed the objects, and it is loud because a silent one would make
    // this record worthless.
    try {
      await this.erasureAudit.record(workerId, erasure);
    } catch (err) {
      this.logger.error(
        `account deletion audit-record write FAILED worker=${idPrefix} (fail-open; the erasure ` +
          `stands and its outcome was ${erasure.outcome}; reason: ${
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
        const redis = (await this.queue.client) as unknown as RedisDeletionClient;
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

    // "COMPLETE" IS NO LONGER UNCONDITIONAL (#712). This line read `account deletion complete …
    // storage_failed=2` — the word a reader scans for, asserting success, beside the number that
    // contradicted it. A failed leg means the worker's data may still be in a bucket, and the
    // acceptance criterion is that such an erasure "does not report the erasure as complete".
    const verdict = erasure.outcome === "failed" ? "INCOMPLETE" : "complete";
    const line =
      `account deletion ${verdict} worker=${idPrefix} sessions=${sessionsRevoked} ` +
      `devices=${devicesRevoked} storage_deleted=${storageDeleted} ` +
      `storage_failed=${storageFailed} outcome=${erasure.outcome} had_pin=${hadPin}`;
    if (erasure.outcome === "failed") this.logger.error(line);
    else this.logger.log(line);
  }
}
