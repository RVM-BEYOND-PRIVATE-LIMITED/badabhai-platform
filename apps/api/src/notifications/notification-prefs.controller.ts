import { Body, Controller, Get, Header, HttpCode, Patch, UseGuards } from "@nestjs/common";
import { Ctx, type RequestContext } from "../common/request-context";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ConsentGuard } from "../auth/consent.guard";
import { NotificationStateService } from "./notification-state.service";
import {
  UpdateNotificationPrefsSchema,
  type UpdateNotificationPrefsDto,
  type NotificationPrefs,
} from "./notifications.dto";

/**
 * The worker's master push-notification toggle (#643). Worker-self + consent-gated,
 * exactly like the Alerts feed it belongs to: the worker id comes from
 * `@CurrentWorker` (the bearer token) — NEVER a path or body id, so there is no IDOR.
 *
 * A separate controller from {@link NotificationsController} only because the path
 * segment differs (`notification-prefs` vs `notifications`); both live in the
 * notifications module, which owns everything the worker sees in Alerts + its settings.
 *
 * `no-store` because the response is worker-scoped state, not cacheable content.
 */
@Controller("workers/me/notification-prefs")
export class NotificationPrefsController {
  constructor(private readonly state: NotificationStateService) {}

  /** Read the toggle. A read → NO event (§1). */
  @Get()
  @Header("Cache-Control", "no-store")
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async get(@CurrentWorker() worker: AuthenticatedWorker): Promise<NotificationPrefs> {
    return this.state.getPrefs(worker.id);
  }

  /**
   * Flip the toggle. Emits a PII-free `worker.notification_prefs_updated`, and the
   * flag really does gate the push fan-out (see PushService.deliver) — the UI promise
   * is backed by the send path, not just stored.
   *
   * Returns the RESULTING prefs so the client can reconcile without a second GET.
   */
  @Patch()
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async update(
    @CurrentWorker() worker: AuthenticatedWorker,
    @Body(new ZodValidationPipe(UpdateNotificationPrefsSchema))
    dto: UpdateNotificationPrefsDto,
    @Ctx() ctx: RequestContext,
  ): Promise<NotificationPrefs> {
    return this.state.updatePrefs(worker.id, dto.notifications_enabled, ctx);
  }
}
