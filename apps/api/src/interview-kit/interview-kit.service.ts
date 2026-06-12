import {
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
import { InterviewKitRenderer } from "./interview-kit-renderer.service";
import { getInterviewKit } from "./interview-kit-content";

/** Where the request came from — maps to a PII-free actor. */
export type KitSource = "worker_app" | "web" | "ops" | "other";

const ACTOR_BY_SOURCE: Record<KitSource, "worker" | "ops" | "system"> = {
  worker_app: "worker",
  web: "worker",
  ops: "ops",
  other: "system",
};

/**
 * Interview-kit serving (Task 4). RENDER-ONCE with STORAGE as the source of truth:
 * a kit is identified by `{tradeKey}:v{contentVersion}` and stored at a deterministic
 * private object key. First request renders + uploads; later requests reuse the
 * stored file. No DB table needed (the content is deterministic per version).
 *
 * PII-FREE: kits are per-trade. Events carry the trade slug + version + kit id only.
 * NO LLM — content is static (interview-kit-content.ts).
 */
@Injectable()
export class InterviewKitService {
  private readonly logger = new Logger(InterviewKitService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    private readonly storage: StorageService,
    private readonly renderer: InterviewKitRenderer,
    private readonly events: EventsService,
  ) {}

  /**
   * Resolve (and on first request, render) a kit, then mint a short-lived signed
   * download URL. Throws 404 for an unknown trade and 503 when rendering is
   * unavailable (kill-switch off / binary missing) and no cached file exists yet.
   */
  async getDownload(
    tradeKey: string,
    ctx: RequestContext,
    opts: { source?: KitSource } = {},
  ): Promise<{
    url: string;
    expires_in: number;
    kit_id: string;
    trade_key: string;
    content_version: number;
    cache_hit: boolean;
  }> {
    const kit = getInterviewKit(tradeKey);
    if (!kit) throw new NotFoundException(`No interview kit for trade '${tradeKey}'`);

    const version = this.config.INTERVIEW_KIT_CONTENT_VERSION;
    const kitId = `${tradeKey}:v${version}`;
    // Object key is built ONLY from a known trade key + numeric version → no path injection.
    const objectKey = `interview-kits/${tradeKey}/v${version}/interview-kit.pdf`;
    const bucket = this.config.INTERVIEW_KIT_BUCKET;
    const source = opts.source ?? "worker_app";

    // Render-once: reuse the stored file if present; otherwise render + store now.
    let cacheHit = await this.storage.objectExists(objectKey, bucket);
    if (!cacheHit) {
      const pdf = await this.renderer.renderPdf(kit, version);
      if (!pdf) {
        // Rendering disabled or the binary is missing, and there is no cached file.
        await this.emitRenderFailed(tradeKey, version, "render_unavailable", ctx);
        throw new ServiceUnavailableException(
          "Interview kit is not available yet; please try again later",
        );
      }
      await this.storage.uploadPdf(objectKey, pdf, bucket);
      await this.events.emit({
        event_name: "interview_kit.render_completed",
        actor: { actor_type: "system" },
        subject: { subject_type: "interview_kit", subject_id: null },
        payload: { trade_key: tradeKey, content_version: version, kit_id: kitId },
        idempotencyKey: `interview_kit.render_completed:${kitId}`,
        correlationId: ctx.correlationId,
        requestId: ctx.requestId,
      });
      this.logger.log(`interview kit ${kitId} rendered + stored`);
      cacheHit = false;
    }

    const ttl = this.config.RESUME_SIGNED_URL_TTL_SECONDS;
    const url = await this.storage.createSignedUrl(objectKey, ttl, bucket);

    await this.events.emit({
      event_name: "interview_kit.downloaded",
      actor: { actor_type: ACTOR_BY_SOURCE[source] },
      subject: { subject_type: "interview_kit", subject_id: null },
      payload: {
        trade_key: tradeKey,
        content_version: version,
        kit_id: kitId,
        source,
        cache_hit: cacheHit,
      },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });

    return {
      url,
      expires_in: ttl,
      kit_id: kitId,
      trade_key: tradeKey,
      content_version: version,
      cache_hit: cacheHit,
    };
  }

  private async emitRenderFailed(
    tradeKey: string,
    version: number,
    reason: string,
    ctx: RequestContext,
  ): Promise<void> {
    await this.events.emit({
      event_name: "interview_kit.render_failed",
      actor: { actor_type: "system" },
      subject: { subject_type: "interview_kit", subject_id: null },
      payload: { trade_key: tradeKey, content_version: version, reason },
      correlationId: ctx.correlationId,
      requestId: ctx.requestId,
    });
  }
}
