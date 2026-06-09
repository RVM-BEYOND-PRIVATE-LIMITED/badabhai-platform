import { Global, Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";

/**
 * Root BullMQ configuration. The Redis connection is derived from REDIS_URL.
 *
 * Phase 1: processors run IN-PROCESS (same Nest app). The queue boundary lets
 * us split them into a dedicated worker process later with no contract change.
 * Redis is required for the async extraction path; if it is down, jobs queue/
 * retry rather than crash the API (postgres.js-style lazy connect).
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [SERVER_CONFIG],
      useFactory: (config: ServerConfig) => ({
        connection: redisConnection(config.REDIS_URL),
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 1000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      }),
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}

/** Parse REDIS_URL into ioredis connection options BullMQ understands. */
function redisConnection(url: string) {
  const u = new URL(url);
  const db = u.pathname && u.pathname !== "/" ? Number(u.pathname.slice(1)) : undefined;
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    username: u.username || undefined,
    password: u.password || undefined,
    db: Number.isFinite(db) ? db : undefined,
    // BullMQ blocking commands require this to be null.
    maxRetriesPerRequest: null,
  };
}
