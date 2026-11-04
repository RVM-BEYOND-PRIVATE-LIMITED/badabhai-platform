import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";
import { payerPasswordAttemptsKey } from "./payer-password-lockout";

/** Minimal typed view of the raw Redis commands the lock-state read needs. */
interface RedisStateClient {
  get(key: string): Promise<string | null>;
}

/**
 * #2563 — a READ-ONLY view of the payer password-attempt counter for the admin accounts list.
 *
 * The counter itself stays owned by `PayerAuthService` (the sign-in door is the only writer).
 * This service exists so the admin module does not reach into the auth service or duplicate
 * the key format, and so the read is BATCHED: a 50-row page is 50 `GET`s on one Redis
 * connection, never 50 round trips through a service that might later grow side effects.
 *
 * FAIL-SOFT FOR THE LIST, FAIL-CLOSED FOR SIGN-IN. A Redis error here returns `null` for that
 * account ("lock state unknown"), never `false`. Reporting an unknown account as unlocked
 * would be a lie an operator acts on; the sign-in door itself still fails closed with a 503 and
 * does not depend on this read. The read must never fail the whole accounts page — the list is
 * an operational view, and losing it because Redis blinked is worse than one unknown cell.
 */
@Injectable()
export class PayerPasswordStateService {
  private readonly logger = new Logger(PayerPasswordStateService.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    // The BullMQ connection is the platform's ONE Redis client (the same rule PayerAuthService
    // follows) — do not open a second client for a read.
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Lock state for each id: `true` when the counter has reached the configured maximum,
   * `false` when it has not, `null` when Redis could not answer.
   */
  async lockStates(payerIds: readonly string[]): Promise<Map<string, boolean | null>> {
    const out = new Map<string, boolean | null>();
    if (payerIds.length === 0) return out;

    let redis: RedisStateClient;
    try {
      redis = (await this.queue.client) as unknown as RedisStateClient;
    } catch (err) {
      this.logger.error(
        `payer lock-state read unavailable (serving unknown for ${payerIds.length} rows; reason: ${
          err instanceof Error ? err.name : "unknown"
        })`,
      );
      for (const id of payerIds) out.set(id, null);
      return out;
    }

    const max = this.config.PAYER_PASSWORD_MAX_ATTEMPTS;
    await Promise.all(
      payerIds.map(async (id) => {
        try {
          const raw = await redis.get(payerPasswordAttemptsKey(id));
          const count = raw ? Number.parseInt(raw, 10) || 0 : 0;
          out.set(id, count >= max);
        } catch {
          // One failed GET marks that row unknown; the rest of the page still renders.
          out.set(id, null);
        }
      }),
    );
    return out;
  }
}
