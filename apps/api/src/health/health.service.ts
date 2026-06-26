import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { sql } from "drizzle-orm";
import type { Database } from "@badabhai/db";
import { DATABASE } from "../database/database.module";
import { RESUME_RENDER_QUEUE } from "../queue/queue.constants";

/** Per-dependency readiness state surfaced in the /health body. */
export type DependencyStatus = "up" | "down";

export interface HealthChecks {
  database: DependencyStatus;
  redis: DependencyStatus;
}

/** Cap each probe so a stuck socket can never hang the /health response. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * Minimal typed view of the one Redis command the probe needs. BullMQ's
 * IRedisClient doesn't declare `ping`, but the runtime client is ioredis which
 * does (same idiom as OtpService's RedisOtpClient).
 */
interface RedisHealthClient {
  ping(): Promise<string>;
}

/**
 * Readiness probes for /health. Each dependency is checked over its EXISTING
 * connection — no new client is opened:
 *   - Postgres: a lightweight `SELECT 1` over the injected Drizzle `Database`
 *     (the pooled postgres.js connection from DatabaseModule).
 *   - Redis: `PING` over the BullMQ ioredis client (`queue.client`), reusing the
 *     same connection the OTP flow uses — do NOT add a second Redis client.
 *
 * Probes run in parallel and each is wrapped in a short timeout. The underlying
 * error (if any) is logged server-side only; it NEVER leaves this service. The
 * caller receives only `up`/`down` so no connection string, host, or error
 * detail can leak into the HTTP body.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    // Reuse BullMQ's existing Redis connection — do NOT add a second client.
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  /** Probe both dependencies in parallel; returns their up/down states. */
  async check(): Promise<HealthChecks> {
    const [database, redis] = await Promise.all([
      this.runProbe("database", () => this.probeDatabase()),
      this.runProbe("redis", () => this.probeRedis()),
    ]);
    return { database, redis };
  }

  /** Lightweight `SELECT 1` over the pooled Drizzle connection. */
  private async probeDatabase(): Promise<void> {
    await this.db.execute(sql`select 1`);
  }

  /** `PING` over the BullMQ ioredis client (the existing OTP/session connection). */
  private async probeRedis(): Promise<void> {
    const client = (await this.queue.client) as unknown as RedisHealthClient;
    await client.ping();
  }

  /**
   * Run one probe under a timeout and never throw: any rejection (including the
   * timeout) maps to `down`, with the underlying reason logged server-side only.
   */
  private async runProbe(
    name: keyof HealthChecks,
    probe: () => Promise<unknown>,
  ): Promise<DependencyStatus> {
    try {
      await this.withTimeout(probe(), name);
      return "up";
    } catch (err) {
      // Log a secret-safe failure tag ONLY — the driver error code (ECONNREFUSED/
      // ETIMEDOUT/…) or the error name. NEVER err.message: a DB/Redis driver could
      // populate it with a connection string / credential (CLAUDE.md §2 — no secrets
      // in logs). The HTTP body already carries only up/down.
      this.logger.warn(`health probe ${name}=down (reason: ${HealthService.safeReason(err)})`);
      return "down";
    }
  }

  /** A non-sensitive failure tag for logs: the error code if present, else its name. */
  private static safeReason(err: unknown): string {
    if (err instanceof Error) {
      const code = (err as { code?: unknown }).code;
      return typeof code === "string" && code.length > 0 ? code : err.name;
    }
    return "unknown";
  }

  /** Reject after PROBE_TIMEOUT_MS so a hung dependency can't stall /health. */
  private async withTimeout<T>(work: Promise<T>, name: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`${name} probe timed out after ${PROBE_TIMEOUT_MS}ms`);
        e.name = "TimeoutError"; // so safeReason() logs a useful, secret-free tag
        reject(e);
      }, PROBE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
