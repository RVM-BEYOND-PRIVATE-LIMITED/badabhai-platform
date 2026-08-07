import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { EventsService } from "../events/events.service";
import { DevicesRepository } from "../auth/devices.repository";
import { NOTIFICATION_TEMPLATES, templateCopy } from "../notifications/notifications.dto";
import { PUSH_QUEUE, type PushJobData } from "../queue/queue.constants";
import { WorkersRepository } from "../workers/workers.repository";
import { PushRepository } from "./push.repository";
import { PUSH_PROVIDER, type PushFailureReason, type PushProvider } from "./push.provider";
import { utcDayStamp, secondsUntilEndOfUtcDay } from "../common/otp-send-cap";

/** Minimal typed view of the raw Redis commands the push daily counter needs. */
interface RedisPushCounter {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
}

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
    @InjectQueue(PUSH_QUEUE) private readonly queue: Queue<PushJobData>,
    private readonly repo: PushRepository,
    private readonly devices: DevicesRepository,
    private readonly events: EventsService,
    private readonly workersRepo: WorkersRepository,
  ) {}

  private async redis(): Promise<RedisPushCounter> {
    return (await this.queue.client) as unknown as RedisPushCounter;
  }

  private static globalSendCountKey(day: string): string {
    return `push:global_sendcount:${day}`;
  }

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

    // The worker's notification state — the push preference and the language for copy.
    // An EXPLICIT non-PII projection (never SELECT *): this payload crosses Google's
    // infrastructure, so the encrypted phone and name must not even be fetched into
    // this path. Fail-soft to defaults on a read error, matching the prior behaviour.
    const state = await this.workersRepo.findNotificationState(job.workerId).catch(() => null);

    // #643 — the worker's own notifications toggle. Checked HERE, before the quota INCR
    // and the device read, so an opted-out worker costs neither a quota slot nor a query.
    //
    // SECURITY ALERTS ARE EXEMPT, deliberately, mirroring the daily-cap exemption below.
    // Two reasons, and the first is decisive:
    //   1. It would be an account-takeover bypass. The pushes in scope today are exactly
    //      the SIM-swap tripwires (`worker.device_registered`, `worker.logged_out_all`).
    //      An attacker holding a stolen session could PATCH this toggle off and then
    //      register their own device in silence — the victim's other handsets would never
    //      ring. A convenience preference must not be able to disarm the alarm that
    //      reports its own misuse.
    //   2. Industry norm: security alerts are non-suppressible on every comparable
    //      platform, precisely because of (1).
    // The gate is therefore correct-but-DORMANT today (every `push: true` template is
    // security-typed) and becomes load-bearing the moment ADR-0034's deferred
    // resume/profile/job pushes are enabled — which is the class a worker actually wants
    // to silence. NOTE this makes the app's "SKIP every push fan-out" comment slightly
    // too broad; see the PR for the FE label follow-up.
    //
    // No event: opting out is a preference, not a delivery failure, so emitting
    // `worker.push_send_failed` would misreport it and skew failure metrics — the same
    // posture as the "no devices to deliver to" return below.
    if (!isSecurity && state?.notificationsEnabled === false) {
      this.logger.log(
        `push skipped worker=${job.workerId} type=${template.type} (notifications disabled)`,
      );
      return { sent: 0 };
    }

    // ADR-0034 / TD91: global daily ceiling on NON-SECURITY pushes. Security alerts
    // (SIM-swap, logout-all) are exempt — FCM is free, and this one class MUST always
    // arrive. The counter uses a Redis INCR keyed per UTC day, same pattern as OTP caps.
    if (!isSecurity) {
      try {
        const redis = await this.redis();
        const day = utcDayStamp();
        const cap = this.config.PUSH_GLOBAL_MAX_SENDS_PER_DAY;
        const key = PushService.globalSendCountKey(day);
        const count = await redis.incr(key);
        await redis.expire(key, secondsUntilEndOfUtcDay());
        if (count > cap) {
          await this.emitFailed(job, "quota");
          this.logger.warn(
            `push daily cap reached limit=${cap} day=${day}; refusing non-security push`,
          );
          return { sent: 0 };
        }
      } catch (err) {
        // Redis error → fail-open for non-security pushes (best-effort volume throttle;
        // a Redis outage must not block delivery). Security pushes skip this path entirely.
        this.logger.warn(
          `push daily counter Redis error; fail-open (reason: ${
            err instanceof Error ? err.message : String(err)
          })`,
        );
      }
    }

    const devices = await this.repo.devicesForDelivery(job.deviceIds);
    if (devices.length === 0) return { sent: 0 };

    // Localized copy off the state read above — one worker read per delivery, not two.
    const copy = templateCopy(template, state?.preferredLanguage ?? null);

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
