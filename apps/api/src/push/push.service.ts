import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { DevicesRepository } from "../auth/devices.repository";
import { NOTIFICATION_TEMPLATES, templateCopy } from "../notifications/notifications.dto";
import type { PushJobData } from "../queue/queue.constants";
import { WorkersRepository } from "../workers/workers.repository";
import { PushRepository } from "./push.repository";
import { PUSH_PROVIDER, type PushFailureReason, type PushProvider } from "./push.provider";

/** In-app destination per notification type. Closed enum — never a free string. */
const ROUTE_BY_TYPE: Record<string, "devices" | "home"> = {
  security: "devices",
};

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    @Inject(PUSH_PROVIDER) private readonly provider: PushProvider,
    private readonly repo: PushRepository,
    private readonly devices: DevicesRepository,
    private readonly events: EventsService,
    private readonly workersRepo: WorkersRepository,
  ) {}

  /**
   * Deliver one fan-out (ADR-0034). Called ONLY from the queue processor — never on a
   * request path.
   *
   * The §2 boundary lives here: copy comes from the static NOTIFICATION_TEMPLATES
   * allowlist keyed by event name, and the event PAYLOAD is never read. So no employer,
   * pay, name, or phone can reach FCM even if some payload carried one — the same
   * property that makes the in-app feed safe, which matters more here because the
   * payload crosses Google's infrastructure.
   */
  async deliver(job: PushJobData): Promise<{ sent: number }> {
    const template = NOTIFICATION_TEMPLATES[job.eventName];
    // Not allowlisted, or allowlisted but not flagged for push → refuse. This is the
    // safety boundary, and it is what stops a push-emitted event from ever being
    // pushable (which would loop: push -> emit -> push).
    if (!template?.push) {
      this.logger.warn(`refusing push for non-push event ${job.eventName}`);
      return { sent: 0 };
    }

    const isSecurity = template.type === "security";
    // The numeric ceiling bounds volume; SECURITY is exempt. The OTP caps it was modelled
    // on bound real MONEY (paid SMS) — FCM is free, and under the ruled scope every push
    // is a security alert, so a numeric cap would silently drop the one class that must
    // always arrive. `0` still halts everything: that is the deliberate stop-the-world
    // lever, and it is checked before the exemption.
    if (this.config.PUSH_GLOBAL_MAX_SENDS_PER_DAY === 0) {
      await this.emitFailed(job, "quota");
      this.logger.warn("push halted — PUSH_GLOBAL_MAX_SENDS_PER_DAY=0 (kill-switch)");
      return { sent: 0 };
    }

    const devices = await this.repo.devicesForDelivery(job.deviceIds);
    if (devices.length === 0) return { sent: 0 };

    // Fetch worker's language for localized copy. Fail-soft to default on error.
    const worker = await this.workersRepo.findById(job.workerId).catch(() => null);
    const lang = worker?.preferredLanguage ?? null;
    const copy = templateCopy(template, lang);

    const route = ROUTE_BY_TYPE[template.type] ?? "home";
    let sent = 0;
    let lastFailure: PushFailureReason | null = null;

    for (const device of devices) {
      const token = device.pushToken;
      const target = device.pushTarget;
      // A row can lose its token between enqueue and delivery (invalidation, or another
      // worker claiming the handset). Nothing to deliver to is a correct outcome.
      if (!token || !target) continue;

      // Claim BEFORE sending: a crash mid-send must not double-deliver on retry.
      const deliveryId = await this.repo.claim(job.sourceEventId, device.id);
      if (!deliveryId) continue; // already delivered for this (event, device)

      const result = await this.provider.send({
        token,
        title: copy.title,
        body: copy.body,
        type: template.type,
        route,
        target,
      });

      if (result.ok) {
        await this.repo.settle(deliveryId, "sent");
        sent += 1;
        continue;
      }

      lastFailure = result.reason;
      await this.repo.settle(deliveryId, "failed", result.reason);
      // ONLY a definitive "this token is dead" verdict clears it. A transport blip must
      // never throw away a working delivery address.
      if (result.reason === "unregistered") {
        await this.devices.clearPushToken(token);
      }
    }

    if (sent > 0) {
      await this.events.emit({
        event_name: "worker.push_sent",
        actor: { actor_type: "system" },
        subject: { subject_type: "worker", subject_id: job.workerId },
        payload: {
          worker_id: job.workerId,
          source_event_id: job.sourceEventId,
          type: template.type,
          device_count: sent,
        },
        idempotencyKey: `worker.push_sent:${job.sourceEventId}`,
      });
    } else if (lastFailure) {
      await this.emitFailed(job, lastFailure);
    }

    // PII-free: ids + counts only, never the token or the copy.
    this.logger.log(
      `push fan-out worker=${job.workerId} type=${template.type} sent=${sent}/${devices.length}${
        isSecurity ? " (security)" : ""
      }`,
    );
    return { sent };
  }

  private async emitFailed(job: PushJobData, reason: PushFailureReason): Promise<void> {
    await this.events.emit({
      event_name: "worker.push_send_failed",
      actor: { actor_type: "system" },
      subject: { subject_type: "worker", subject_id: job.workerId },
      payload: {
        worker_id: job.workerId,
        source_event_id: job.sourceEventId,
        reason,
      },
    });
  }
}
