import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../../config/config.module";
import { RESUME_RENDER_QUEUE } from "../../queue/queue.constants";
import { withinRedisDeadline } from "../../queue/redis-deadline";

/**
 * Minimal typed view of the raw Redis commands this store needs — the same narrowing
 * `CompanionMemoryStore` / `AdminMfaSecretStore` / `ResumeRateLimit` use, because BullMQ's
 * `IRedisClient` declares only what BullMQ itself calls.
 */
interface RedisFaltuClient {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  pttl(key: string): Promise<number>;
}

/** The strike window is one UTC day (O11), so the counter lives exactly that long. */
const STRIKE_TTL_SECONDS = 24 * 60 * 60;

/**
 * FALTU'S STRIKE COUNTER AND COOL-DOWN (ADR-0046 O11, contracts §7) — Redis only, on the
 * BullMQ connection, like every v2 store.
 *
 *   `companion:v2:strikes:{workerId}:{utcDay}`  INCR, 24 h — resets with the UTC day
 *   `companion:v2:cooldown:{workerId}`          flag, `FALTU_COOLDOWN_MINUTES` — presence = cooling
 *
 * FAIL OPEN, DELIBERATELY, AND ONLY HERE. Every other v2 store fails soft (memory read → no
 * context; proposal → no card). These two must fail open for the same reason inverted: a Redis
 * outage must not SILENCE a worker. No counter → the redirect is still served; no cool-down
 * flag → free text flows as normal. The cost of failing open is bounded by the model spend the
 * O12 ledger already watches; the cost of failing closed is a worker who cannot use the tab.
 *
 * WHAT IS NEVER STORED: no worker text. The keys carry an opaque worker uuid and a UTC day; the
 * values are a count and a flag.
 */
@Injectable()
export class FaltuStore {
  private readonly logger = new Logger(FaltuStore.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    // Borrow BullMQ's existing Redis connection — never a second client. Nothing enqueues here.
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  private static strikesKey(workerId: string, utcDay: string): string {
    return `companion:v2:strikes:${workerId}:${utcDay}`;
  }

  private static cooldownKey(workerId: string): string {
    return `companion:v2:cooldown:${workerId}`;
  }

  private async client(): Promise<RedisFaltuClient> {
    return (await this.queue.client) as unknown as RedisFaltuClient;
  }

  /**
   * Count one strike for this UTC day and return the running total.
   *
   * `null` means the counter is UNREACHABLE — no strike was counted, and the caller must serve
   * the redirect without pretending a count it does not have. The TTL is set on the first
   * increment only, so the window expires 24 h after the day's first strike rather than being
   * pushed forward by every later one.
   */
  async countStrike(workerId: string, utcDay: string): Promise<number | null> {
    try {
      const redis = await this.client();
      const key = FaltuStore.strikesKey(workerId, utcDay);
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, STRIKE_TTL_SECONDS);
      return count;
    } catch (err) {
      this.logger.warn(
        `faltu strike not counted for worker ${workerId} (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
      return null;
    }
  }

  /**
   * Start the cool-down and return the ISO instant it ends, or `null` when Redis refused —
   * in which case no cool-down exists and the worker keeps the tab.
   */
  async startCooldown(workerId: string, now: Date): Promise<string | null> {
    const seconds = this.config.CHAT_COMPANION_V2_FALTU_COOLDOWN_MINUTES * 60;
    try {
      await (await this.client()).set(FaltuStore.cooldownKey(workerId), "1", "EX", seconds);
      return new Date(now.getTime() + seconds * 1_000).toISOString();
    } catch (err) {
      this.logger.warn(
        `faltu cooldown not started for worker ${workerId} (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
      return null;
    }
  }

  /**
   * When the cool-down ends, or `null` for "not cooling down" — and for "Redis unreachable",
   * which fails open by design. Only a POSITIVE remaining TTL counts: a key without one cannot
   * be produced by `startCooldown`, and treating it as an eternal cool-down would silence a
   * worker over a state this code cannot create.
   *
   * BOUNDED BY `withinRedisDeadline`, because this read sits on the tab's OPEN
   * (`GET /chat/companion`) and in front of every free-text message: on the shared connection a
   * command against a downed Redis never rejects, so without the bound "fails open" would be a
   * hung chat tab. The two writers above are NOT bounded yet: an abandoned INCR or SET still
   * lands after the timeout, as a strike or a cool-down the strike event never reported, and
   * that trade is not this read's to make — so a Redis outage still stalls a faltu turn.
   */
  async cooldownUntil(workerId: string, now: Date): Promise<string | null> {
    try {
      const remainingMs = await withinRedisDeadline(async () =>
        (await this.client()).pttl(FaltuStore.cooldownKey(workerId)),
      );
      if (remainingMs <= 0) return null;
      return new Date(now.getTime() + remainingMs).toISOString();
    } catch (err) {
      this.logger.warn(
        `faltu cooldown unreadable for worker ${workerId}; serving normally (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
      return null;
    }
  }
}
