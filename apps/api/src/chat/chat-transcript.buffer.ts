import { Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import type { ServerConfig } from "@badabhai/config";
import { SERVER_CONFIG } from "../config/config.module";
import { PROFILE_EXTRACTION_QUEUE, type ProfileExtractionJobData } from "../queue/queue.constants";

/**
 * The in-flight interview, held in Redis instead of Postgres.
 *
 * WHY THIS EXISTS. The profiling chat used to write four Postgres rows per turn — an
 * inbound message, an outbound message, and two events — plus a conversation_state
 * UPDATE. For a 30-turn interview that is ~150 writes to record a conversation that is
 * only interesting once it is FINISHED: nothing downstream reads a half-collected
 * profile, and a worker who abandons the chat on turn three leaves three permanent
 * rows describing nothing. The whole conversation now buffers here and flushes ONCE,
 * transactionally, when the interview completes.
 *
 * WHAT IS DELIBERATELY *NOT* HERE. `chat_sessions` is still created in Postgres at
 * `POST /chat/session`, and it stays there: it is the OWNERSHIP record (the row
 * `postMessage` checks before it will touch a buffer) and the audit fact that a worker
 * began an interview. Ownership must not live in a cache — a lapsed key would turn
 * "not your session" into "no such session" for the real owner, and an absent key must
 * never be the thing that decides who may write.
 *
 * BLAST RADIUS, stated plainly because it is a real trade. Redis is the ONLY home of an
 * in-flight interview. Losing it loses every conversation currently mid-flight — not
 * corrupts, loses: the `chat_sessions` row survives and the worker starts over. That is
 * the accepted cost of not writing 150 rows per profile, and it is bounded by
 * CHAT_TRANSCRIPT_TTL_SECONDS, which resets on every turn so it caps IDLENESS rather
 * than total interview length.
 *
 * FAIL CLOSED, ALWAYS. Every method throws 503 rather than degrade. A `load` that
 * swallowed an outage would silently restart a worker's interview at question one; a
 * `save` that swallowed one would serve a reply whose answer was never recorded, so the
 * next turn re-asks what the worker just told us. Both look like the product forgetting
 * them mid-sentence. An honest 503 that they can retry is strictly kinder, and — since
 * nothing was written — it costs a turn and never a topic.
 */

/** One buffered line. `role` mirrors the ai-contracts ConversationMessage vocabulary. */
export interface BufferedMessage {
  role: "worker" | "assistant";
  /**
   * The message VERBATIM, exactly as `chat_messages.body_text` will hold it at flush.
   *
   * For an assistant line that means the raw reply carrying the literal
   * `{{worker_name}}` placeholder — NEVER the interpolated real name (SG-1). For a
   * worker line it means their actual words, un-redacted: this is the audit spine and
   * the extraction corpus. Redaction and pseudonymization happen on the way OUT to the
   * ai-service, never on the way in here.
   */
  text: string;
  at: string;
}

/** The whole in-flight interview. Serialized to one Redis string per session. */
export interface TranscriptBuffer {
  /**
   * The owning worker, copied in at creation.
   *
   * NOT the authorization check — `ChatService` proves ownership against the
   * `chat_sessions` row before it ever asks for a buffer, because a cache miss must
   * never be able to answer an authorization question. This copy exists so the FLUSH
   * can attribute rows without a second read, and as a tripwire: a buffer whose
   * workerId disagrees with the session row means key reuse, and is discarded.
   */
  workerId: string;
  /** Completed turns so far. The budget CHAT_MAX_TURNS is spent against this. */
  turnCount: number;
  /**
   * The Resume Field Set as filled so far — `{field_id: short value}`, the closed
   * vocabulary the ai-service owns. This is what makes "never ask what has already
   * been answered" work with no deterministic engine tracking it: it is fed back to
   * the model every turn.
   *
   * PROFILE SIGNALS ONLY. There is no RFS field for a name, phone, address, employer
   * or any ID; the persona forbids asking for them and pseudonymize blocks them
   * upstream — so this map has nowhere to put identity PII even when a worker
   * volunteers some.
   */
  captured: Record<string, string>;
  /** The trade hint carried across turns. A hint to the model, never an instruction. */
  roleFamily: string;
  messages: BufferedMessage[];
  startedAt: string;
  /** Set once the service declares the interview over; the flush is then owed. */
  completedAt?: string;
  /** Why it ended — `fields_complete` | `turn_cap`. Observability only. */
  completionReason?: string;
}

/**
 * Minimal typed view of the Redis commands the buffer needs. BullMQ's `IRedisClient`
 * only declares the subset BullMQ itself uses; the runtime client is ioredis, which
 * has the `EX` variadic `set`. Narrowed to an interface rather than `any` so the call
 * sites stay type-checked (same pattern as ResumeRateLimit / SessionService).
 */
interface RedisTranscriptClient {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
}

/**
 * Hard ceiling on buffered lines, independent of CHAT_MAX_TURNS.
 *
 * The turn cap already bounds a well-behaved interview (2 messages per turn), so this
 * never fires in normal use. It exists because the turn cap is enforced by
 * `ChatService` and this class must not depend on that being correct: a bug there, or
 * a future caller that appends outside the turn loop, would otherwise grow one Redis
 * value without limit. Oldest lines are dropped first — recency is what the model
 * needs, and the flush writes whatever survives.
 */
export const TRANSCRIPT_BUFFER_MAX_MESSAGES = 600;

@Injectable()
export class ChatTranscriptBuffer {
  private readonly logger = new Logger(ChatTranscriptBuffer.name);

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: ServerConfig,
    // Reuse BullMQ's existing Redis connection — do NOT open a second client. This
    // queue is also the one the flush enqueues extraction onto, so the dependency is
    // one the chat path already has.
    @InjectQueue(PROFILE_EXTRACTION_QUEUE)
    private readonly queue: Queue<ProfileExtractionJobData>,
  ) {}

  static key(sessionId: string): string {
    return `chat:transcript:${sessionId}`;
  }

  /** A fresh buffer for a session whose first message just arrived. Not yet stored. */
  static create(workerId: string, roleFamily: string, now: Date): TranscriptBuffer {
    return {
      workerId,
      turnCount: 0,
      captured: {},
      roleFamily,
      messages: [],
      startedAt: now.toISOString(),
    };
  }

  /**
   * The buffered interview, or `null` when there is none (first turn, or the TTL
   * lapsed and the worker is starting over).
   *
   * A stored value that will not parse is treated as absent and DELETED rather than
   * thrown on: the alternative is a session permanently wedged on a bad key, which no
   * retry can clear. Logged with the session id only.
   */
  async load(sessionId: string): Promise<TranscriptBuffer | null> {
    const key = ChatTranscriptBuffer.key(sessionId);
    let raw: string | null;
    try {
      raw = await (await this.redis()).get(key);
    } catch (err) {
      throw this.unavailable("load", sessionId, err);
    }
    if (raw === null) return null;

    try {
      const parsed = JSON.parse(raw) as unknown;
      return this.narrow(parsed);
    } catch {
      this.logger.warn(
        `transcript buffer for session ${sessionId} was unreadable; discarding it ` +
          `(the interview restarts rather than staying wedged on a bad key)`,
      );
      await this.drop(sessionId);
      return null;
    }
  }

  /** Write the buffer back and RESET the TTL, so idleness is what expires, not length. */
  async save(sessionId: string, buffer: TranscriptBuffer): Promise<void> {
    const bounded: TranscriptBuffer = {
      ...buffer,
      messages: buffer.messages.slice(-TRANSCRIPT_BUFFER_MAX_MESSAGES),
    };
    if (bounded.messages.length !== buffer.messages.length) {
      this.logger.warn(
        `transcript buffer for session ${sessionId} exceeded ` +
          `${TRANSCRIPT_BUFFER_MAX_MESSAGES} messages; dropped ` +
          `${buffer.messages.length - bounded.messages.length} oldest`,
      );
    }
    try {
      await (await this.redis()).set(
        ChatTranscriptBuffer.key(sessionId),
        JSON.stringify(bounded),
        "EX",
        this.config.CHAT_TRANSCRIPT_TTL_SECONDS,
      );
    } catch (err) {
      throw this.unavailable("save", sessionId, err);
    }
  }

  /**
   * Delete the buffer. Called AFTER a successful flush — never before, and never in a
   * `finally`: the Postgres transaction is what makes the transcript durable, so
   * dropping the key on a failed flush would destroy the only copy of the interview.
   *
   * Never throws. By the time this runs the data is safely in Postgres, so a Redis
   * blip here costs a stale key that the TTL reaps anyway. Failing the request at that
   * point would tell a worker their completed interview failed when it did not.
   */
  async drop(sessionId: string): Promise<void> {
    try {
      await (await this.redis()).del(ChatTranscriptBuffer.key(sessionId));
    } catch (err) {
      this.logger.warn(
        `could not delete transcript buffer for session ${sessionId} ` +
          `(harmless — the TTL reaps it): ${String(err)}`,
      );
    }
  }

  /** `Queue.client` is a PROMISE of the ioredis connection — it must be awaited. */
  private async redis(): Promise<RedisTranscriptClient> {
    return (await this.queue.client) as unknown as RedisTranscriptClient;
  }

  /**
   * Shape-check a parsed value. Deliberately structural rather than a Zod schema: the
   * only writer is this class, so the realistic failure is a truncated/legacy value,
   * not a hostile one, and anything that does not look like a buffer is discarded
   * exactly like unparseable JSON. Unknown extra keys are dropped, not preserved —
   * this rebuilds the object field-by-field so a stale key from an older shape cannot
   * ride back into Postgres at flush.
   */
  private narrow(value: unknown): TranscriptBuffer | null {
    if (typeof value !== "object" || value === null) return null;
    const v = value as Record<string, unknown>;
    if (typeof v.workerId !== "string" || !v.workerId) return null;
    if (!Array.isArray(v.messages)) return null;

    const messages: BufferedMessage[] = [];
    for (const m of v.messages) {
      if (typeof m !== "object" || m === null) continue;
      const msg = m as Record<string, unknown>;
      if (msg.role !== "worker" && msg.role !== "assistant") continue;
      if (typeof msg.text !== "string") continue;
      messages.push({
        role: msg.role,
        text: msg.text,
        at: typeof msg.at === "string" ? msg.at : new Date(0).toISOString(),
      });
    }

    const captured: Record<string, string> = {};
    if (typeof v.captured === "object" && v.captured !== null) {
      for (const [k, val] of Object.entries(v.captured as Record<string, unknown>)) {
        if (typeof val === "string") captured[k] = val;
      }
    }

    return {
      workerId: v.workerId,
      turnCount: typeof v.turnCount === "number" && v.turnCount >= 0 ? v.turnCount : 0,
      captured,
      roleFamily: typeof v.roleFamily === "string" ? v.roleFamily : "",
      messages,
      startedAt: typeof v.startedAt === "string" ? v.startedAt : new Date(0).toISOString(),
      ...(typeof v.completedAt === "string" ? { completedAt: v.completedAt } : {}),
      ...(typeof v.completionReason === "string"
        ? { completionReason: v.completionReason }
        : {}),
    };
  }

  /**
   * The fail-closed 503. Logs the opaque session id and the error only — a buffer
   * holds the worker's actual words, and none of them may reach a log line (§2).
   */
  private unavailable(op: string, sessionId: string, err: unknown): ServiceUnavailableException {
    this.logger.error(
      `transcript buffer ${op} failed for session ${sessionId}; failing closed ` +
        `rather than losing the interview: ${err instanceof Error ? err.message : String(err)}`,
    );
    return new ServiceUnavailableException(
      "Chat is temporarily unavailable; please send that again in a moment",
    );
  }
}
