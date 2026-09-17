import { randomUUID } from "node:crypto";

import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";

import { SERVER_CONFIG } from "../config/config.module";
import type { RequestContext } from "../common/request-context";
import { EventsService } from "../events/events.service";
import { StorageService } from "../storage/storage.service";
import { WorkersRepository } from "../workers/workers.repository";
import {
  portfolioKeyBelongsTo,
  type MyPortfolioResponse,
  type PortfolioUploadUrlDto,
  type SetMyPortfolioDto,
} from "./worker-portfolio.dto";
import { WorkerPortfolioRepository } from "./worker-portfolio.repository";

/** Declared content type → the extension the server picks. Never client-supplied. */
const EXTENSION_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

/** The signed-URL TTL for portfolio media reads. */
const PORTFOLIO_SIGNED_URL_TTL_SECONDS = 900;

/**
 * The worker's portfolio (ADR-0042 D9 / Layer A (e), migration 0113).
 *
 * ═══ THE BUCKET IS DORMANT WHEN UNSET, LIKE PHOTOS ═══
 *
 * `WORKER_PORTFOLIO_BUCKET` empty → the mint route answers 503 and the feature is dark; the LINK
 * kind needs no bucket at all and keeps working. That is the shipped contract, not a placeholder.
 *
 * ═══ NOT EMPLOYER-VISIBLE ═══
 *
 * Nothing on the employer copy reads this table (the renderer's audience gate is where any future
 * printing decision lands). The worker-self GET is the only read.
 */
@Injectable()
export class WorkerPortfolioService {
  private readonly logger = new Logger(WorkerPortfolioService.name);

  constructor(
    private readonly portfolio: WorkerPortfolioRepository,
    private readonly workers: WorkersRepository,
    private readonly events: EventsService,
    private readonly storage: StorageService,
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
  ) {}

  /** Mint a signed upload for one media item; 503 while the bucket is dormant. */
  async createUploadUrl(
    workerId: string,
    dto: PortfolioUploadUrlDto,
  ): Promise<{ upload_url: string; storage_key: string; expires_in: number }> {
    const bucket = this.config.WORKER_PORTFOLIO_BUCKET;
    if (!bucket) throw new ServiceUnavailableException("portfolio uploads not enabled");
    const extension = EXTENSION_BY_CONTENT_TYPE[dto.content_type.toLowerCase()];
    if (!extension || !this.contentTypeMatchesKind(dto, extension)) {
      throw new BadRequestException("unsupported content type for this kind");
    }
    const key = `portfolio/${workerId}/${randomUUID()}.${extension}`;
    const signed = await this.storage.createSignedUploadUrl(key, bucket);
    return { upload_url: signed.url, storage_key: key, expires_in: signed.expiresIn };
  }

  async replaceForWorker(
    workerId: string,
    dto: SetMyPortfolioDto,
    ctx: RequestContext,
  ): Promise<{ worker_id: string; item_count: number }> {
    const worker = await this.workers.findById(workerId);
    if (!worker) throw new NotFoundException(`Worker ${workerId} not found`);

    const items = dto.items.map((item) => ({
      kind: item.kind,
      // A KEY THE SERVER DID NOT MINT FOR THIS WORKER IS REFUSED, not stored and hidden later.
      storageKey: item.storage_key ?? null,
      url: item.url ?? null,
      caption: item.caption ?? null,
    }));
    for (const item of items) {
      if (item.storageKey !== null && !portfolioKeyBelongsTo(workerId, item.storageKey)) {
        throw new NotFoundException("portfolio media not found");
      }
    }

    const { itemsWritten, replacedExisting } = await this.portfolio.replaceForWorker(
      workerId,
      items,
    );

    await this.events.emit({
      event_name: "worker.portfolio_recorded",
      actor: { actor_type: "worker", actor_id: workerId },
      subject: { subject_type: "worker", subject_id: workerId },
      // COUNTS ONLY — never a caption, a key or a URL.
      payload: {
        worker_id: workerId,
        item_count: itemsWritten,
        replaced_existing: replacedExisting,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
    this.logger.log(
      `portfolio recorded for worker ${workerId}: ${itemsWritten} item(s)` +
        (replacedExisting ? ", replaced existing rows" : ""),
    );
    return { worker_id: workerId, item_count: itemsWritten };
  }

  async getForWorker(workerId: string): Promise<MyPortfolioResponse> {
    const rows = await this.portfolio.loadForWorker(workerId);
    const bucket = this.config.WORKER_PORTFOLIO_BUCKET;
    const items = await Promise.all(
      rows.map(async (row) => {
        if (row.kind === "link") {
          return { kind: "link" as const, url: row.url, caption: row.caption };
        }
        let url: string | null = null;
        if (bucket && row.storageKey) {
          try {
            url = await this.storage.createSignedUrl(
              row.storageKey,
              PORTFOLIO_SIGNED_URL_TTL_SECONDS,
              bucket,
            );
          } catch {
            this.logger.warn(
              `could not sign a portfolio object for worker ${workerId}; returning it unlinked`,
            );
          }
        }
        return { kind: row.kind as "photo" | "video", url, caption: row.caption };
      }),
    );
    return { items };
  }

  private contentTypeMatchesKind(dto: PortfolioUploadUrlDto, extension: string): boolean {
    const isVideo = extension === "mp4" || extension === "mov";
    return dto.kind === "video" ? isVideo : !isVideo;
  }
}
