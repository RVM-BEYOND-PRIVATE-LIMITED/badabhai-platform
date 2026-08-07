import { Controller, Get, Header, HttpCode, Post, UseGuards } from "@nestjs/common";
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ConsentGuard } from "../auth/consent.guard";
import { NotificationsService } from "./notifications.service";
import { NotificationStateService } from "./notification-state.service";
import { type WorkerNotification } from "./notifications.dto";

/**
 * Worker Alerts feed (spec §5.11). Worker-self + consent-gated: the worker id comes
 * from @CurrentWorker (the bearer token) — NEVER a path/body id (no IDOR). Projects
 * the worker's OWN real events into faceless, PII-FREE rows (see
 * {@link NotificationsService}).
 *
 * A read → NO event emitted (§1). `no-store` because the response is worker-scoped.
 */
@Controller("workers/me/notifications")
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly state: NotificationStateService,
  ) {}

  @Get()
  @Header("Cache-Control", "no-store")
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async list(
    @CurrentWorker() worker: AuthenticatedWorker,
  ): Promise<{ notifications: WorkerNotification[] }> {
    return { notifications: await this.notifications.getForWorker(worker.id) };
  }

  /**
   * #643 — mark the worker's Alerts read up to now, by advancing the server-side
   * watermark. Makes read state CROSS-DEVICE and survive a reinstall, which local-only
   * read state cannot.
   *
   * Worker from `@CurrentWorker`, never a body — the body is deliberately EMPTY and
   * unread: the watermark is always "now", so there is nothing for a client to choose
   * and no value it could backdate. IDEMPOTENT (the watermark only moves forward), so
   * a retry is a safe no-op.
   *
   * NO event (§1) — a read position is not a business action; see
   * {@link NotificationStateService.markRead}.
   */
  @Post("read")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async markRead(@CurrentWorker() worker: AuthenticatedWorker): Promise<{ ok: true }> {
    await this.state.markRead(worker.id);
    return { ok: true };
  }
}
