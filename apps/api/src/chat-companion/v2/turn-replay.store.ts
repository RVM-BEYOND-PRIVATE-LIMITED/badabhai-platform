import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { RESUME_RENDER_QUEUE } from "../../queue/queue.constants";
import { CompanionTurnSchema, type CompanionTurn } from "../chat-companion.dto";

/**
 * Minimal typed view of the raw Redis KV commands this store needs — the same narrowing
 * `EditProposalStore` uses (ioredis at runtime, BullMQ's interface declares less).
 */
interface RedisKvClient {
  set(key: string, value: string, expiryMode: "EX", seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

/**
 * How long a served turn stays replayable. The app retries by hand (a failed bubble's tap) after
 * its 15 s request timeout, so minutes cover every realistic retry; it matches the default edit
 * card lifetime, so a replayed card is never older than the card itself could be.
 */
export const TURN_REPLAY_TTL_SECONDS = 600;

/**
 * THE SERVED-TURN REPLAY CACHE (contracts §7) — what makes a RETRIED message idempotent.
 *
 * The app mints one `submission_id` per physical send and re-sends it verbatim on a retry (#870).
 * The v1 turn and the v2 turn EVENT were already deduped by it; the v2 pipeline's side effects
 * were not — a retry re-ran the classifier (billed twice), the handler (a second faltu strike, a
 * second career answer, a new edit proposal) and the memory append. So the turn a free-text
 * message was answered with is kept under `companion:v2:turn:{workerId}:{submissionId}`, and a
 * retry with the same id is answered with THAT turn, byte for byte, with no model call, no strike,
 * no memory append and no second event.
 *
 * FAIL OPEN, like the faltu store and for the same reason: a Redis outage must not cost the worker
 * their answer. An unreadable cache is a miss (the message is processed as before this existed);
 * an unwritten one costs only a future retry its replay. A stored value that no longer parses as
 * a turn is a miss too — Redis is ours, but never trusted as typed.
 *
 * WHAT IS STORED is the turn the worker was already SENT: reviewed copy, a validated career
 * answer, or an edit card — whose before/after values are the ones `proposal:{workerId}` already
 * holds for the same lifetime. Never the worker's message, never logged.
 */
@Injectable()
export class CompanionTurnReplayStore {
  private readonly logger = new Logger(CompanionTurnReplayStore.name);

  constructor(
    // Reuse BullMQ's existing Redis connection — do NOT add a second client. The queue is
    // borrowed for its connection only; nothing enqueues to it from here.
    @InjectQueue(RESUME_RENDER_QUEUE) private readonly queue: Queue,
  ) {}

  /** `companion:v2:turn:{workerId}:{submissionId}` — worker-scoped, so an id cannot cross workers. */
  private static key(workerId: string, submissionId: string): string {
    return `companion:v2:turn:${workerId}:${submissionId}`;
  }

  private async client(): Promise<RedisKvClient> {
    return (await this.queue.client) as unknown as RedisKvClient;
  }

  /** The turn already served for this submission, or null (never served, expired, unreadable). */
  async read(workerId: string, submissionId: string): Promise<CompanionTurn | null> {
    try {
      const raw = await (await this.client()).get(CompanionTurnReplayStore.key(workerId, submissionId));
      if (raw === null) return null;
      const parsed = CompanionTurnSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch (err) {
      this.logger.warn(
        `companion turn replay unreadable for worker ${workerId}; processing the message (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
      return null;
    }
  }

  /** Keep the served turn for a retry — best-effort, never throws. */
  async remember(workerId: string, submissionId: string, turn: CompanionTurn): Promise<void> {
    try {
      await (
        await this.client()
      ).set(
        CompanionTurnReplayStore.key(workerId, submissionId),
        JSON.stringify(turn),
        "EX",
        TURN_REPLAY_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.warn(
        `companion turn replay not stored for worker ${workerId} (${
          err instanceof Error ? err.name : "UnknownError"
        })`,
      );
    }
  }
}
