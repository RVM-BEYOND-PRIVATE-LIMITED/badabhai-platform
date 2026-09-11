import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { ServerConfig } from "@badabhai/config";
import {
  RESUME_UPLOAD_MIME_TYPES,
  WORKER_RESUME_UPLOAD_PREFIX,
  type ResumeUploadMimeName,
} from "@badabhai/types";
import type { WorkerResumeImport } from "@badabhai/db";

import { SERVER_CONFIG } from "../../config/config.module";
import type { RequestContext } from "../../common/request-context";
import { EventsService } from "../../events/events.service";
import { StorageService } from "../../storage/storage.service";
import {
  RESUME_IMPORT_PARSE_QUEUE,
  type ResumeImportParseJobData,
} from "../../queue/queue.constants";
import { ResumeImportRepository } from "./resume-import.repository";
import {
  extensionForResumeMime,
  RESUME_UPLOAD_EXTENSIONS,
  type ConfirmResumeImportDto,
  type CreateResumeUploadUrlDto,
} from "./resume-import.dto";

/**
 * Résumé import — the upload half (ADR-0041, phase RI-1).
 *
 * WHAT THIS DOES AND DELIBERATELY DOES NOT DO. It mints a signed upload URL, and it registers
 * the object that came back. It does not read the document, does not call a model, and does not
 * touch the worker's profile — extraction is RI-2, the parse is RI-3, and the prefill is RI-4.
 * Landing the storage half on its own is what lets the privacy review in RI-3 look at one flag
 * rather than at a feature.
 *
 * ── DORMANCY COVERS EVERY DOOR, NOT JUST THE MINT ────────────────────────────────────────
 *
 * Both public write methods check `RESUME_UPLOADS_BUCKET` and 503 while it is unset. That is
 * the #1245 lesson paid for on the voice seam, where only `createUploadUrl` read the bucket, so
 * with it unset a client could still POST the confirm and register durable rows describing audio
 * that had nowhere to live. Everything downstream then treats those rows as real. "Off" has to
 * mean off at every door.
 *
 * ── THE ORDER OF THE CHECKS IN `confirm` IS THE SECURITY ARGUMENT ────────────────────────
 *
 * shape → dormancy → object-info → policy → persist. The shape check runs FIRST and touches no
 * storage at all, so a forged key is refused without ever telling the caller whether the object
 * behind it exists. Reversing those two would turn this route into an existence oracle for
 * another worker's bucket contents.
 */
@Injectable()
export class ResumeImportService {
  private readonly logger = new Logger(ResumeImportService.name);

  constructor(
    private readonly imports: ResumeImportRepository,
    private readonly events: EventsService,
    private readonly storage: StorageService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    @InjectQueue(RESUME_IMPORT_PARSE_QUEUE)
    private readonly parseQueue: Queue<ResumeImportParseJobData>,
  ) {}

  /**
   * Mint a signed upload URL into the private résumé-uploads bucket.
   *
   * The object key is SERVER-controlled — an opaque UUID under the caller's own prefix — and the
   * only thing the client's declared mime decides is the extension. NO event: minting is an
   * authorization grant, not a state change, and the registration event belongs to `confirm`.
   * The response carries a signed URL, which is a bearer credential: never logged, never emitted,
   * and marked `no-store` by the controller.
   */
  async createUploadUrl(workerId: string, dto: CreateResumeUploadUrlDto) {
    const bucket = this.requireBucket();

    const objectKey =
      `${WORKER_RESUME_UPLOAD_PREFIX}/${workerId}/${randomUUID()}` +
      `.${extensionForResumeMime(dto.mime)}`;
    const { url, expiresIn } = await this.storage.createSignedUploadUrl(objectKey, bucket);

    return { storage_path: objectKey, upload_url: url, expires_in: expiresIn };
  }

  /**
   * Register an object the client has just PUT, after proving it is real and within policy.
   *
   * IDEMPOTENT ON THE KEY. A client that PUTs, loses our response, and retries gets the ORIGINAL
   * row back rather than a 500 from the unique index. That matters more here than it looks: the
   * workers this is built for are on weak connections, and a retry storm that 500s would leave
   * them staring at a failure for an upload that actually succeeded.
   */
  async confirm(workerId: string, dto: ConfirmResumeImportDto, ctx: RequestContext) {
    // (a) SHAPE FIRST, and before any storage call — see the class docblock. A key we did not
    // mint for THIS worker is refused without disclosing whether anything is stored at it.
    if (!this.mintedKeyShape(workerId).test(dto.storage_path)) {
      throw new BadRequestException("storage_path not owned by caller");
    }

    // (b) Dormancy at this door too, not only at the mint.
    const bucket = this.requireBucket();

    // (c) A retry of a confirm that already succeeded. Checked before object-info so the common
    // retry costs one indexed read rather than a storage round trip.
    const existing = await this.imports.findByStorageKey(dto.storage_path);
    if (existing) {
      // The unique index guarantees at most one row; the ownership check above guarantees the
      // key is this worker's. Belt and braces, because returning another worker's row here
      // would be the whole game.
      if (existing.workerId !== workerId) {
        throw new BadRequestException("storage_path not owned by caller");
      }
      return this.toResponse(existing);
    }

    // (d) THE OBJECT ITSELF. The signed URL cannot constrain what the client actually PUT, so
    // the bytes are measured after the fact. Fail closed: absent metadata reads as
    // out-of-policy rather than being guessed at — this is a PII class, we do not guess.
    const info = await this.storage.getObjectInfo(dto.storage_path, bucket);
    if (!info) {
      throw new BadRequestException("uploaded object not found; upload before confirming");
    }

    const mime = info.contentType;
    const size = info.sizeBytes;
    const mimeOk = mime !== null && (RESUME_UPLOAD_MIME_TYPES as readonly string[]).includes(mime);
    const sizeOk =
      size !== null && size > 0 && size <= this.config.RESUME_UPLOAD_MAX_BYTES;

    if (!mimeOk || !sizeOk) {
      // Never leave out-of-policy PII bytes behind an unreferenced key. A failed cleanup must
      // not mask the 400 — the object is unreferenced and still prefix-swept on account
      // deletion, which under ruling D6 is the only sweep this bucket ever gets.
      await this.bestEffortDelete(dto.storage_path, bucket, workerId, "out-of-policy object");
      throw new BadRequestException(
        "résumé must be a PDF, DOCX, JPEG or PNG within the size limit",
      );
    }

    const row = await this.imports.create({
      workerId,
      storageKey: dto.storage_path,
      // Recorded from object-info, NEVER from the client's declaration at mint time.
      mime,
      byteSize: size,
      status: "uploaded",
    });

    // PII-FREE: two ids, a closed-set mime and a magnitude. No filename — workers name these
    // files after themselves, so "Ramesh Kumar CV.pdf" is a full name, and it would reach the
    // spine through a field nobody would think to review. The event schema refuses it; this
    // comment is here so nobody tries.
    await this.events.emit({
      event_name: "profile.resume_imported",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      payload: {
        worker_id: workerId,
        import_id: row.id,
        mime: mime as ResumeUploadMimeName,
        byte_size: size,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    // THE READING HAPPENS OFF THE REQUEST PATH (ADR-0041 RI-4). Downloading, rasterising,
    // possibly running OCR and then one model call is tens of seconds on a photographed sheet,
    // and the worker is holding a phone waiting for this response.
    //
    // ENQUEUE FAILURE IS NOT CONFIRM FAILURE. The object is stored, the row is registered and
    // `profile.resume_imported` has been emitted — all of that is true whether or not Redis is
    // reachable. Turning a queue outage into a 500 here would tell the worker his upload failed
    // when it did not, and would leave him re-uploading a document we already hold. He is never
    // blocked either way: the client polls `GET :importId`, and a row that never leaves
    // `uploaded` sends him into the chat, which is the no-résumé path ruling D9 guarantees.
    try {
      await this.parseQueue.add("parse", {
        importId: row.id,
        workerId,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
    } catch (error) {
      this.logger.error(
        `résumé parse enqueue failed for import ${row.id}; the import stays at 'uploaded' and ` +
          `the worker continues in the chat: ${(error as Error).message}`,
      );
    }

    // Never the key, never the filename, never the size in a way that identifies the document.
    this.logger.log(`résumé import registered for worker ${workerId.slice(0, 8)}…`);
    return this.toResponse(row);
  }

  /**
   * Read one import back. Owner only.
   *
   * DELIBERATELY NOT PURPOSE-GATED at the controller, and the reasoning is `VoiceController`'s
   * verbatim: this route processes nothing. It reads back the status of something the worker
   * already gave us. Gating it would lock a worker out of his own data at the moment he
   * withdrew consent, which inverts what withdrawal is for and cuts against the DPDP access
   * right. Erasure, not this route, is what removes an import.
   */
  async get(workerId: string, importId: string) {
    const row = await this.imports.findForWorker(importId, workerId);
    // 404 for both not-found and not-owner — no existence oracle for another worker's imports.
    if (!row) throw new NotFoundException(`Résumé import ${importId} not found`);
    return this.toResponse(row);
  }

  // ---- internals -------------------------------------------------------------------------

  private requireBucket(): string {
    const bucket = this.config.RESUME_UPLOADS_BUCKET;
    if (!bucket) {
      // 503 rather than 404: the feature exists and is switched off, which is a different fact
      // from "no such route" and is what lets a client degrade honestly (ruling D9's posture).
      throw new ServiceUnavailableException("résumé uploads not enabled");
    }
    return bucket;
  }

  /**
   * The FULL shape of a key we minted for this worker — not a prefix test.
   *
   * A prefix test would admit `resume-uploads/{workerId}/../../other/thing`, a free-text suffix
   * (self-chosen text in an object key), or a nested path. `workerId` is session-derived and a
   * UUID (hex and dashes only), so interpolating it carries no regex metacharacter; the
   * extension alternation is built from the closed set in the DTO rather than written out here,
   * so a fifth document type widens the mint and this check together.
   */
  private mintedKeyShape(workerId: string): RegExp {
    const extensions = RESUME_UPLOAD_EXTENSIONS.join("|");
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- the only interpolated values are `workerId` (session-derived, a UUID of hex + dashes) and a closed extension set compiled into this build. Neither can carry a regex metacharacter or widen the pattern. `dto.storage_path` is the string being TESTED, never part of the pattern.
    return new RegExp(
      `^${WORKER_RESUME_UPLOAD_PREFIX}/${workerId}/` +
        `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}` +
        `\\.(${extensions})$`,
    );
  }

  private async bestEffortDelete(
    key: string,
    bucket: string,
    workerId: string,
    why: string,
  ): Promise<void> {
    try {
      await this.storage.deletePdf(key, bucket);
    } catch {
      this.logger.warn(
        `résumé ${why} cleanup failed for worker ${workerId.slice(0, 8)}…; ` +
          `object stays prefix-sweepable`,
      );
    }
  }

  /**
   * The wire shape.
   *
   * NOTE WHAT IS ABSENT: the storage key. The client already knows it — the mint handed it over
   * — so echoing it back buys nothing, and a response field is a thing that ends up in a client
   * log, a crash report, or a screenshot. `suggestions_enc` is absent for the obvious reason.
   */
  private toResponse(row: WorkerResumeImport) {
    return {
      import_id: row.id,
      status: row.status,
      route: row.route,
      form_kind: row.formKind,
      failure_reason: row.failureReason,
    };
  }
}
