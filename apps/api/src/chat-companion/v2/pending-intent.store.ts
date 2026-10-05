import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { RESUME_RENDER_QUEUE } from "../../queue/queue.constants";
import { withinRedisDeadline } from "../../queue/redis-deadline";

/**
 * THE PENDING INTENT (TD146, WP6) — the one turn of memory a task-chip tap leaves behind.
 *
 * A tap on `companion_task:edit_resume` / `companion_task:career_talk` names a task, not a
 * request (contracts §5.3), and today the NEXT message starts from zero: v1's aliases can claim
 * it ("location badalna hai" hits the résumé menu) and the tap is forgotten. With
 * `CHAT_COMPANION_V2_ROUTE_PRECEDENCE_ENABLED` on, the tap stores the task here and the next
 * free-text message routes straight to that handler — no v1 resolver, no classifier call.
 *
 * ONE-SHOT, PER WORKER, 10 MINUTES. `take` reads and deletes in one atomic command, so exactly
 * one message can use an intent; a second copy of the same message (a retry, a double-send) finds
 * nothing and takes the normal path. A new tap replaces the value (`set`), and any OTHER chip
 * clears it — the caller owns both. The 10-minute TTL is not configurable: it bounds how long a
 * forgotten tap can steer a later message, and the knob list (contracts §6) does not carry one.
 *
 * FAIL SOFT, LIKE THE MEMORY STORE. A Redis outage means no pending intent — the message takes
 * the normal v1-first path, which is today's behaviour — never a failed turn. Reads run under
 * `withinRedisDeadline` because a command on the shared BullMQ connection against a downed Redis
 * never rejects; a write abandoned at the deadline may still land later, which is harmless (a
 * stale intent expires on its own).
 *
 * THE VALUE IS A CLOSED SET, validated on the way out as well as in: Redis is ours, but a value
 * written by an older build is not trusted as typed.
 */
export const PENDING_INTENTS = ["edit_resume", "career_talk"] as const;
export type PendingIntent = (typeof PENDING_INTENTS)[number];

/** The intent's lifetime — see the class comment. */
const PENDING_TTL_SECONDS = 600;

interface RedisPendingClient {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

function isPendingIntent(value: string): value is PendingIntent {
  return (PENDING_INTENTS as readonly string[]).includes(value);
}

@Injectable()
export class PendingIntentStore {
  private readonly logger = new Logger(PendingIntentStore.name);

  constructor(
    // Reuse BullMQ's existing Redis connection — do NOT add a second client. The queue is
    // borrowed for its connection only; nothing enqueues to it from here.
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  private static key(workerId: string): string {
    return `companion:v2:pending-intent:${workerId}`;
  }

  private async client(): Promise<RedisPendingClient> {
    return (await this.queue.client) as unknown as RedisPendingClient;
  }

  /** Remember (or replace) the worker's pending intent. Best-effort; never throws. */
  async set(workerId: string, intent: PendingIntent): Promise<void> {
    try {
      await withinRedisDeadline(async () =>
        (await this.client()).set(PendingIntentStore.key(workerId), intent, "EX", PENDING_TTL_SECONDS),
      );
    } catch (err) {
      this.logger.warn(
        `pending intent not stored for worker ${workerId} (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
    }
  }

  /** Consume the worker's pending intent — one-shot. Null when absent, expired or unreadable. */
  async take(workerId: string): Promise<PendingIntent | null> {
    try {
      const raw = await withinRedisDeadline(async () =>
        (await this.client()).getdel(PendingIntentStore.key(workerId)),
      );
      return raw !== null && isPendingIntent(raw) ? raw : null;
    } catch (err) {
      this.logger.warn(
        `pending intent not read for worker ${workerId} (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
      return null;
    }
  }

  /** Drop the worker's pending intent — another chip was tapped. Best-effort; never throws. */
  async clear(workerId: string): Promise<void> {
    try {
      await withinRedisDeadline(async () => (await this.client()).del(PendingIntentStore.key(workerId)));
    } catch (err) {
      this.logger.warn(
        `pending intent not cleared for worker ${workerId} (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
    }
  }
}
