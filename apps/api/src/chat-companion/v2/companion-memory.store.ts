import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { z } from "zod";
import type { ServerConfig } from "@badabhai/config";
import type { CompanionRecentTurn } from "@badabhai/ai-contracts";
import { SERVER_CONFIG } from "../../config/config.module";
import { RESUME_RENDER_QUEUE } from "../../queue/queue.constants";
import { withinRedisDeadline } from "../../queue/redis-deadline";

/**
 * Minimal typed view of the raw Redis list commands this store needs. BullMQ's `IRedisClient`
 * declares only what BullMQ itself uses (no RPUSH/LRANGE/LTRIM), but the runtime client is
 * ioredis — the same narrowing `AdminMfaSecretStore` and `ResumeRateLimit` use, so the call
 * sites stay type-checked instead of `any`.
 */
interface RedisListClient {
  rpush(key: string, ...values: string[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  expire(key: string, seconds: number): Promise<number>;
}

/** One stored turn, validated on the way out (Redis is ours, but never trusted as typed). */
const StoredTurnSchema = z
  .object({
    role: z.enum(["worker", "bada_bhai"]),
    text: z.string().min(1).max(1000),
  })
  .strict();

/**
 * THE COMPANION'S SHORT-TERM MEMORY (ADR-0046 O13) — the last few turns of the Bada Bhai tab,
 * so "aur yeh bhi add karo" has an antecedent when the classifier runs.
 *
 * REDIS ONLY, NEVER POSTGRES. This is conversational context, not a record: it expires on its
 * own and a flush costs a worker nothing but a little context. `companion:v2:mem:{workerId}` is
 * a LIST, oldest first, trimmed to `CHAT_COMPANION_V2_MEMORY_TURNS` on every append and given
 * `CHAT_COMPANION_V2_MEMORY_TTL_SECONDS` on every append (not just the first — a TTL-less list
 * would live forever if a process died between RPUSH and EXPIRE).
 *
 * WHAT IS STORED IS ALREADY PSEUDONYMIZED: the orchestrator appends the masked text the AI
 * service returned, never the raw message (contracts §7). THE ONE EXCEPTION is
 * `AI_RAW_PII_ENABLED` (owner decision 2026-09-30): while it is on the orchestrator skips the
 * gateway and appends the worker's own words, so this list then holds raw text — still Redis
 * only, still trimmed, still expiring on the TTL above. TURNING IT OFF DOES NOT CLEAR THEM: an
 * entry carries no raw-or-masked marker, and because every append re-asserts the TTL, a raw
 * turn stored while the flag was on outlives the revert until `MEMORY_TURNS` newer entries trim
 * it out or the TTL lapses after that worker's last turn. It is replayed as `recent_turns`
 * meanwhile, which the ai-service masks again before the model while the flag is off, so the
 * residue is at rest only. An immediate at-rest revert deletes the `companion:v2:mem:*` keys —
 * a flush costs a worker nothing but a little context. Nothing here writes a log line with a
 * turn's text, and a failed read is simply "no memory" — the turn proceeds without it.
 *
 * BOTH METHODS RUN UNDER `withinRedisDeadline`. On the shared connection a command against a
 * downed Redis never rejects, so without the bound "fail soft" was a hung v1-miss message. An
 * append abandoned at the deadline may still land later; it is the pair the worker was served.
 */
@Injectable()
export class CompanionMemoryStore {
  private readonly logger = new Logger(CompanionMemoryStore.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    // Reuse BullMQ's existing Redis connection — do NOT add a second client. The queue is
    // borrowed for its connection only; nothing enqueues to it from here.
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  /** `companion:v2:mem:{workerId}` — the one namespace this store owns. */
  private static key(workerId: string): string {
    return `companion:v2:mem:${workerId}`;
  }

  private async client(): Promise<RedisListClient> {
    return (await this.queue.client) as unknown as RedisListClient;
  }

  /**
   * The worker's recent turns, OLDEST FIRST, or `[]` on any failure.
   *
   * FAIL SOFT, unlike the rate limiter next door: memory is an enrichment, so a Redis outage
   * must cost the classifier its context and never the worker their answer (contracts §7).
   * An entry that does not parse is dropped silently — a turn written by an older build is not
   * an incident, and one bad entry must not erase the rest.
   */
  async read(workerId: string): Promise<CompanionRecentTurn[]> {
    const turns = this.config.CHAT_COMPANION_V2_MEMORY_TURNS;
    try {
      const raw = await withinRedisDeadline(async () =>
        (await this.client()).lrange(CompanionMemoryStore.key(workerId), -turns, -1),
      );
      const parsed: CompanionRecentTurn[] = [];
      for (const entry of raw) {
        try {
          const turn = StoredTurnSchema.safeParse(JSON.parse(entry));
          if (turn.success) parsed.push(turn.data);
        } catch {
          // A non-JSON entry is dropped, not fatal.
        }
      }
      return parsed;
    } catch (err) {
      this.logger.warn(
        `companion memory unreadable for worker ${workerId}; classifying without it (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
      return [];
    }
  }

  /**
   * Append one turn, trim to the cap and (re)assert the TTL — best-effort.
   *
   * A failed append costs the NEXT turn its context and nothing else; the worker's answer is
   * already being served from the current message. Never throws, and never logs the text.
   */
  async append(workerId: string, turn: CompanionRecentTurn): Promise<void> {
    const key = CompanionMemoryStore.key(workerId);
    try {
      await withinRedisDeadline(async () => {
        const redis = await this.client();
        await redis.rpush(key, JSON.stringify(turn));
        await redis.ltrim(key, -this.config.CHAT_COMPANION_V2_MEMORY_TURNS, -1);
        await redis.expire(key, this.config.CHAT_COMPANION_V2_MEMORY_TTL_SECONDS);
      });
    } catch (err) {
      this.logger.warn(
        `companion memory not appended for worker ${workerId} (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
    }
  }
}
