import { Controller, Get, Header, UseGuards } from "@nestjs/common";
import {
  WorkerAuthGuard,
  CurrentWorker,
  type AuthenticatedWorker,
} from "../auth/worker-auth.guard";
import { ConsentGuard } from "../auth/consent.guard";
import { NotificationsService } from "./notifications.service";
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
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @Header("Cache-Control", "no-store")
  @UseGuards(WorkerAuthGuard, ConsentGuard)
  async list(
    @CurrentWorker() worker: AuthenticatedWorker,
  ): Promise<{ notifications: WorkerNotification[] }> {
    return { notifications: await this.notifications.getForWorker(worker.id) };
  }
}
