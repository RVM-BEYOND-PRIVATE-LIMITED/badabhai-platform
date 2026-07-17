import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import type { RequestContext } from "../common/request-context";
import { PiiCryptoService } from "../common/pii-crypto.service";
import { EventsService } from "../events/events.service";
import { StorageService } from "../storage/storage.service";
import { RESUME_RENDER_QUEUE, type ResumeRenderJobData } from "../queue/queue.constants";
import { WorkersRepository } from "./workers.repository";
import { toProfileSummary } from "./profile-summary.mapper";
import type {
  ConfirmPhotoDto,
  WorkerProfileSummary,
  WorkerResumeFields,
  UpdateResumePrefsDto,
} from "./workers.dto";

/** ADR-0032 — photo-confirm validation bounds (ruled in the ADR, enforced here). */
const PHOTO_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB
const PHOTO_ALLOWED_MIME = new Set(["image/jpeg", "image/png"]);

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
    private readonly storage: StorageService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    @InjectQueue(RESUME_RENDER_QUEUE)
    private readonly renderQueue: Queue<ResumeRenderJobData>,
  ) {}

  /**
   * ADR-0032 / TD77 — re-render the worker's LATEST resume PDF after a change that
   * affects only PRESENTATION: a photo added/replaced/removed, or the show_photo
   * pref flipped.
   *
   * WHY THIS EXISTS: the render processor skips a resume that is already
   * 'rendered' (correct for retries). A worker's resume is auto-generated when
   * their profile is confirmed — i.e. BEFORE they ever add a photo — so without a
   * forced re-render the photo would never appear on the PDF, no matter which
   * screen they set it from.
   *
   * LLM-FREE + version-stable: the render reads the stored profile SNAPSHOT + the
   * server-decrypted name + the photo bytes — no AI call, no AI spend, no new
   * resume version. The SAME object key is overwritten, so the existing PDF keeps
   * serving until the fresh one lands — a refresh never costs the worker their
   * download. (The ONE exception is the `failClosed` remove direction: there a
   * terminal failure DOES take the PDF out of service, because serving a face the
   * worker erased is worse than a 409.)
   *
   * BEST-EFFORT: a queue failure must NEVER fail the photo/prefs write that
   * triggered it (mirrors ResumeService.enqueueRender). Refs only — no PII is
   * enqueued, and the reason is logged without the key/name.
   *
   * CALLERS MUST ONLY CALL THIS WHEN THE PDF WOULD ACTUALLY CHANGE (i.e. the photo
   * is/was visible on it). A render that cannot alter a single byte is pure cost on
   * a shared queue. `failClosed` marks the REMOVE direction — see the field doc on
   * {@link ResumeRenderJobData.failClosed}.
   */
  private async enqueueResumeRerender(
    workerId: string,
    ctx: RequestContext,
    opts: { failClosed: boolean },
  ): Promise<void> {
    try {
      const latest = await this.workers.latestResume(workerId);
      // No resume yet → nothing to re-render; the first generate picks the photo up.
      if (!latest) return;
      await this.renderQueue.add("render", {
        resumeId: latest.id,
        workerId,
        force: true,
        failClosed: opts.failClosed,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    } catch (err) {
      this.logger.warn(
        `could not enqueue resume re-render for worker ${workerId} (reason: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
  }

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
      // ADR-0032: boolean projection of the photo POINTER — never the key/URL.
      has_photo: typeof worker.photoStorageKey === "string" && worker.photoStorageKey.length > 0,
    };
  }

  /**
   * ADR-0032 — mint a signed UPLOAD url for the worker's profile photo
   * (POST /workers/me/photo/upload-url). The SERVER chooses the object key
   * (`photos/{workerId}/{uuid}.jpg` — the client controls nothing about the
   * destination); the client PUTs the bytes directly to Storage, so image bytes
   * never transit this API. 503 fail-closed while WORKER_PHOTOS_BUCKET is unset
   * (dormant — the voice-seam pattern).
   *
   * DELIBERATELY NO EVENT: minting is an authorization grant, not a state change
   * (§1) — `worker.photo_uploaded` is emitted by the CONFIRM step. The signed URL
   * embeds a bearer token and is NEVER logged or emitted.
   */
  async createPhotoUploadUrl(
    workerId: string,
  ): Promise<{ storage_path: string; upload_url: string; expires_in: number }> {
    const bucket = this.config.WORKER_PHOTOS_BUCKET;
    if (!bucket) {
      throw new ServiceUnavailableException("photo uploads not enabled");
    }
    const objectKey = `photos/${workerId}/${randomUUID()}.jpg`;
    const { url, expiresIn } = await this.storage.createSignedUploadUrl(objectKey, bucket);
    return { storage_path: objectKey, upload_url: url, expires_in: expiresIn };
  }

  /**
   * ADR-0032 — confirm a profile-photo upload (POST /workers/me/photo). Verifies:
   * (a) the registered `storage_path` matches the minted-key shape for THIS worker
   *     (anti path-forgery — the voice-seam regex pattern; a mismatch is a 400 and
   *     never touches storage);
   * (b) the uploaded OBJECT is real and within policy — `image/jpeg`/`image/png`,
   *     ≤ 2 MiB — validated against Storage object-info (the signed URL itself
   *     cannot constrain what the client PUTs). An out-of-policy object is
   *     best-effort deleted and the confirm 400s (fail closed, no orphan pointer).
   * Then persists the pointer, best-effort deletes a REPLACED photo's old object,
   * and emits `worker.photo_uploaded` (PII-free: worker_id only).
   */
  async confirmPhoto(
    workerId: string,
    dto: ConfirmPhotoDto,
    ctx: RequestContext,
  ): Promise<{ worker_id: string; has_photo: true }> {
    const bucket = this.config.WORKER_PHOTOS_BUCKET;
    if (!bucket) {
      throw new ServiceUnavailableException("photo uploads not enabled");
    }

    // (a) minted-key shape for THIS worker — uuid v4 under the caller's own prefix.
    const mintedKeyShape = new RegExp(
      `^photos/${workerId}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.jpg$`,
    );
    if (!mintedKeyShape.test(dto.storage_path)) {
      throw new BadRequestException("storage_path not owned by caller");
    }

    const worker = await this.workers.findById(workerId);
    if (!worker) throw new NotFoundException(`Worker ${workerId} not found`);

    // (b) the object itself — exists, right type, within the size cap. Fail closed:
    // missing metadata reads as out-of-policy (a face photo is a PII class; we do
    // not guess). Object-info transport failures propagate (500) rather than guess.
    const info = await this.storage.getObjectInfo(dto.storage_path, bucket);
    if (!info) {
      throw new BadRequestException("uploaded object not found; upload before confirming");
    }
    const mimeOk = info.contentType !== null && PHOTO_ALLOWED_MIME.has(info.contentType);
    const sizeOk = info.sizeBytes !== null && info.sizeBytes > 0 && info.sizeBytes <= PHOTO_MAX_BYTES;
    if (!mimeOk || !sizeOk) {
      // Best-effort removal of the out-of-policy object — never leave PII bytes
      // behind a dangling unreferenced key. Failure to clean up must not mask the
      // 400 (the object is unreferenced and prefix-swept on account deletion).
      try {
        await this.storage.deletePdf(dto.storage_path, bucket);
      } catch {
        this.logger.warn(
          `photo confirm cleanup failed for worker ${workerId.slice(0, 8)}…; object stays prefix-sweepable`,
        );
      }
      throw new BadRequestException("photo must be a JPEG/PNG of at most 2MB");
    }

    const oldKey = worker.photoStorageKey;
    const updated = await this.workers.updatePhotoStorageKey(workerId, dto.storage_path);
    if (!updated) throw new NotFoundException(`Worker ${workerId} not found`);

    // Replacing a photo: best-effort delete of the superseded object (its pointer is
    // gone; a failed delete is an opaque orphan, swept on account deletion).
    if (oldKey && oldKey !== dto.storage_path) {
      try {
        await this.storage.deletePdf(oldKey, bucket);
      } catch {
        this.logger.warn(
          `superseded photo delete failed for worker ${workerId.slice(0, 8)}…; object stays prefix-sweepable`,
        );
      }
    }

    await this.events.emit({
      event_name: "worker.photo_uploaded",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      payload: { worker_id: workerId },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    this.logger.log(`profile photo recorded for worker ${workerId}`); // never the key/URL
    // TD77: put the new photo onto the worker's existing resume PDF (top-right of
    // the template). ONLY when show_photo is on — with it off the render gate drops
    // the photo anyway, so a re-render could not change one byte of the PDF.
    if (worker.resumeShowPhoto) {
      await this.enqueueResumeRerender(workerId, ctx, { failClosed: false });
    }
    return { worker_id: workerId, has_photo: true };
  }

  /**
   * ADR-0032 — short-lived signed READ url for the worker's OWN photo
   * (GET /workers/me/photo-url). Own-session only; the signed URL is a bearer
   * credential — the controller sets Cache-Control: no-store and the URL is never
   * logged or emitted. 404 when no photo (and for a missing worker — no oracle).
   * 503 while dormant. DELIBERATELY NO EVENT (read, §1).
   */
  async getPhotoUrl(workerId: string): Promise<{ url: string; expires_in: number }> {
    const bucket = this.config.WORKER_PHOTOS_BUCKET;
    if (!bucket) {
      throw new ServiceUnavailableException("photos not enabled");
    }
    const worker = await this.workers.findById(workerId);
    if (!worker?.photoStorageKey) {
      throw new NotFoundException("no photo");
    }
    const ttl = this.config.RESUME_SIGNED_URL_TTL_SECONDS;
    const url = await this.storage.createSignedUrl(worker.photoStorageKey, ttl, bucket);
    return { url, expires_in: ttl };
  }

  /**
   * ADR-0032 — remove the worker's profile photo (DELETE /workers/me/photo).
   * IDEMPOTENT: no photo → 200 `{ has_photo: false }` with NO event (§1 — nothing
   * changed; a fabricated `photo_removed` would be a fake event). With a photo:
   * clears the pointer FIRST (data minimization is never blocked), best-effort
   * deletes the object only when the bucket is configured (dormancy skips the
   * object, mirroring the account-deletion gate), then emits `worker.photo_removed`.
   */
  async deletePhoto(
    workerId: string,
    ctx: RequestContext,
  ): Promise<{ worker_id: string; has_photo: false }> {
    const worker = await this.workers.findById(workerId);
    if (!worker) throw new NotFoundException(`Worker ${workerId} not found`);

    const key = worker.photoStorageKey;
    if (!key) {
      return { worker_id: workerId, has_photo: false };
    }

    const updated = await this.workers.updatePhotoStorageKey(workerId, null);
    if (!updated) throw new NotFoundException(`Worker ${workerId} not found`);

    const bucket = this.config.WORKER_PHOTOS_BUCKET;
    if (bucket) {
      try {
        await this.storage.deletePdf(key, bucket);
      } catch {
        this.logger.warn(
          `photo object delete failed for worker ${workerId.slice(0, 8)}…; object stays prefix-sweepable`,
        );
      }
    }

    await this.events.emit({
      event_name: "worker.photo_removed",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      payload: { worker_id: workerId },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    this.logger.log(`profile photo removed for worker ${workerId}`);
    // TD77: take the photo back OFF the worker's existing resume PDF — but only if it
    // was ever ON it (show_photo off ⇒ the PDF never carried the face, nothing to
    // erase). failClosed: this render's purpose is to remove PII, so a terminal
    // failure must NOT keep serving the face the worker just erased.
    if (worker.resumeShowPhoto) {
      await this.enqueueResumeRerender(workerId, ctx, { failClosed: true });
    }
    return { worker_id: workerId, has_photo: false };
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
    // TD77: the "Photo dikhayein" toggle decides whether the photo is on the PDF, so
    // a REAL flip must re-render it on/off. Two gates keep this from burning renders
    // that cannot change a byte: compared before-vs-after (not "was show_photo in the
    // body"), AND only when a photo actually exists to show/hide. Turning the toggle
    // OFF takes the face off the PDF ⇒ failClosed (never serve erased PII).
    const hasPhoto =
      typeof worker.photoStorageKey === "string" && worker.photoStorageKey.length > 0;
    if (hasPhoto && worker.resumeShowPhoto !== updated.resumeShowPhoto) {
      await this.enqueueResumeRerender(workerId, ctx, { failClosed: !updated.resumeShowPhoto });
    }
    return { worker_id: workerId };
  }
}
