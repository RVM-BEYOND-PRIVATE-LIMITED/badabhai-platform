import { randomUUID } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";

import { RESUME_RENDER_QUEUE } from "../../queue/queue.constants";
import { withinRedisDeadline } from "../../queue/redis-deadline";

/**
 * How long one fold may hold its session's lock. Well above the slowest fold — the 8 s summarize
 * budget plus a row read and a merge — and short enough that a process that dies mid-fold frees
 * the session within a minute. A lock that lapses early is harmless: the merge is monotonic, so a
 * stale fold can never overwrite a newer one.
 */
export const FREE_CHAT_FOLD_LOCK_TTL_SECONDS = 60;

/**
 * Minimal typed view of the Redis commands the lock needs — the narrowing every borrowed-connection
 * store uses (ioredis at runtime; BullMQ's interface declares less).
 */
interface RedisLockClient {
  set(
    key: string,
    value: string,
    expiryMode: "EX",
    seconds: number,
    condition: "NX",
  ): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

/** Delete the key only while it still holds OUR token, so a lapsed lock is never freed by its old holder. */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * AT MOST ONE ROLLING-SUMMARY FOLD IN FLIGHT PER SESSION (ADR-0051 §8) — `SET NX EX` on
 * `chat:free-chat:fold:{sessionId}`, on BullMQ's existing connection (never a second client).
 *
 * FAILS CLOSED, the opposite of the companion's fail-open stores, and for the opposite reason: the
 * fold is optional work nobody waits on, so "Redis did not answer" means "do not fold now" — the
 * next casual reply retries the same lines, because the stored watermark never moved. Every call
 * runs under `withinRedisDeadline`, so a downed Redis costs the background fold 150 ms, never a hang.
 *
 * NEVER STORES TEXT: the key is an opaque session id and the value a random token.
 */
@Injectable()
export class FreeChatFoldLock {
  private readonly logger = new Logger(FreeChatFoldLock.name);

  constructor(
    // Borrow BullMQ's existing Redis connection — nothing enqueues here.
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  private static key(sessionId: string): string {
    return `chat:free-chat:fold:${sessionId}`;
  }

  /**
   * #2297 (ADR-0056) — the Bada Bhai chat's fold lock: ONE fold in flight per WORKER (the companion
   * has no session). Its own namespace, so it can never collide with a session's key.
   */
  private static companionKey(workerId: string): string {
    return `companion:fold:${workerId}`;
  }

  private async client(): Promise<RedisLockClient> {
    return (await this.queue.client) as unknown as RedisLockClient;
  }

  /** Take the session's fold lock: the token that releases it, or null — held elsewhere, or no Redis. */
  async acquire(sessionId: string): Promise<string | null> {
    return this.acquireKey(FreeChatFoldLock.key(sessionId), `session=${sessionId}`);
  }

  /** Free the lock if it is still ours. Best effort: the TTL frees it anyway. Never throws. */
  async release(sessionId: string, token: string): Promise<void> {
    await this.releaseKey(FreeChatFoldLock.key(sessionId), token, `session=${sessionId}`);
  }

  /** #2297 — take the worker's companion fold lock (same semantics as {@link acquire}). */
  async acquireCompanion(workerId: string): Promise<string | null> {
    return this.acquireKey(FreeChatFoldLock.companionKey(workerId), `worker=${workerId}`);
  }

  /** #2297 — free the worker's companion fold lock if it is still ours. Never throws. */
  async releaseCompanion(workerId: string, token: string): Promise<void> {
    await this.releaseKey(FreeChatFoldLock.companionKey(workerId), token, `worker=${workerId}`);
  }

  private async acquireKey(key: string, ref: string): Promise<string | null> {
    const token = randomUUID();
    try {
      const result = await withinRedisDeadline(async () =>
        (await this.client()).set(key, token, "EX", FREE_CHAT_FOLD_LOCK_TTL_SECONDS, "NX"),
      );
      return result === "OK" ? token : null;
    } catch (err) {
      this.logger.warn(
        `free-chat fold lock unavailable ${ref}; no fold now (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
      return null;
    }
  }

  private async releaseKey(key: string, token: string, ref: string): Promise<void> {
    try {
      await withinRedisDeadline(async () =>
        (await this.client()).eval(RELEASE_SCRIPT, 1, key, token),
      );
    } catch (err) {
      this.logger.warn(
        `free-chat fold lock not released ${ref}; it lapses on its TTL (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
    }
  }
}
